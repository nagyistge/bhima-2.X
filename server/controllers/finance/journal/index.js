/** The /journal HTTP API endpoint
 *
 * @module finance/journal/
 *
 * @description
 * This module is responsible for handling CRUD operations
 * against the `posting journal` table.
 *
 * @requires q
 * @requires lodash
 * @requires uuid/v4
 * @requires lib/db
 * @requires lib/filter
 * @requires lib/errors/NotFound
 * @requires lib/errors/BadRequest
 */

const q = require('q');
const _ = require('lodash');
const uuid = require('uuid/v4');

// module dependencies
const db = require('../../../lib/db');
const FilterParser = require('../../../lib/filter');
const NotFound = require('../../../lib/errors/NotFound');
const BadRequest = require('../../../lib/errors/BadRequest');

// Fiscal Service
const FiscalService = require('../../finance/fiscal');

// expose to the api
exports.list = list;
exports.getTransaction = getTransaction;
exports.reverse = reverse;
exports.find = find;
exports.buildTransactionQuery = buildTransactionQuery;

exports.getTransactionEditHistory = getTransactionEditHistory;

exports.editTransaction = editTransaction;
exports.count = count;
exports.commentPostingJournal = commentPostingJournal;

/**
 * Looks up a transaction by record_uuid.
 *
 * @param {String} record_uuid - the record uuid
 * @returns {Promise} object - a promise resolving to the part of transaction object.
 */
function lookupTransaction(recordUuid) {
  const options = {
    record_uuid : recordUuid,
    includeNonPosted : true,
  };

  return find(options)
    .then((result) => {
      // if no records matching, throw a 404
      if (result.length === 0) {
        throw new NotFound(`Could not find a transaction with record_uuid: ${recordUuid}.`);
      }

      return result;
    });
}

// @TODO(sfount) find a more efficient way of combining multiple table sets than a union all on the final results
//               - new method should be proven as more efficient on large data sets before being accepted
//
// Current merge logic : subset 1 UNION ALL subset 2 ORDER
// 1. select all from the posting journal including all joins, conditions etc.
// 2. select all from the general ledger including all joins, conditions etc.
// 3. UNION ALL between both complete sets of data
// 4. Apply date order
function naiveTransactionSearch(options, includeNonPosted) {
  // hack to ensure only the correct amount of rows are returned - this should be improved
  // in the more efficient method of selection
  let limitCondition = '';
  if (options.limit) {
    limitCondition = ` LIMIT ${Number(options.limit)}`;
  }

  if (!includeNonPosted) {
    const query = buildTransactionQuery(_.cloneDeep(options), false);
    return db.exec(`(${query.sql}) ORDER BY trans_date DESC ${limitCondition}`, query.parameters);
  }

  // clone options as filter parsing process mutates object
  const posted = buildTransactionQuery(_.cloneDeep(options), true);
  const nonPosted = buildTransactionQuery(_.cloneDeep(options), false);

  const combinedParameters = posted.parameters.concat(nonPosted.parameters);

  return db.exec(
    `(${posted.sql}) UNION ALL (${nonPosted.sql}) ORDER BY trans_date DESC ${limitCondition}`,
    combinedParameters
  );
}

// if posted ONLY return posted transactions
// if not posted ONLY return non-posted transactions
function buildTransactionQuery(options, posted) {
  db.convert(options, ['uuid', 'record_uuid', 'uuids', 'record_uuids']);

  const filters = new FilterParser(options, { tableAlias : 'p' });

  const table = posted ? 'general_ledger' : 'posting_journal';

  let typeIds = [];

  if (options.origin_id) {
    typeIds = typeIds.concat(options.origin_id);
  }

  const sql = `
    SELECT BUID(p.uuid) AS uuid, ${posted} as posted, p.project_id, p.fiscal_year_id, p.period_id,
      p.trans_id, p.trans_date, BUID(p.record_uuid) AS record_uuid,
      dm1.text AS hrRecord, p.description, p.account_id, p.debit, p.credit,
      p.debit_equiv, p.credit_equiv, p.currency_id, c.name AS currencyName,
      BUID(p.entity_uuid) AS entity_uuid, em.text AS hrEntity,
      BUID(p.reference_uuid) AS reference_uuid, dm2.text AS hrReference,
      p.comment, p.origin_id, p.user_id, p.cc_id, p.pc_id, pro.abbr,
      pro.name AS project_name, per.start_date AS period_start,
      per.end_date AS period_end, a.number AS account_number, a.label AS account_label, u.display_name
    FROM ${table} p
      JOIN project pro ON pro.id = p.project_id
      JOIN period per ON per.id = p.period_id
      JOIN account a ON a.id = p.account_id
      JOIN user u ON u.id = p.user_id
      JOIN currency c ON c.id = p.currency_id
      LEFT JOIN entity_map em ON em.uuid = p.entity_uuid
      LEFT JOIN document_map dm1 ON dm1.uuid = p.record_uuid
      LEFT JOIN document_map dm2 ON dm2.uuid = p.reference_uuid
  `;

  filters.period('period', 'trans_date');
  filters.dateFrom('custom_period_start', 'trans_date');
  filters.dateTo('custom_period_end', 'trans_date');

  filters.fullText('description');
  filters.fullText('comment');

  filters.equals('user_id');
  filters.equals('account_id');
  filters.equals('project_id');
  filters.equals('trans_id');
  filters.equals('record_uuid');

  filters.custom('origin_id', 'p.origin_id IN (?)', [typeIds]);

  filters.custom('uuids', 'p.uuid IN (?)', [options.uuids]);
  filters.custom('record_uuids', 'p.record_uuid IN (?)', [options.record_uuids]);
  filters.custom('amount', '(credit_equiv = ? OR debit_equiv = ?)', [options.amount, options.amount]);

  return {
    sql : filters.applyQuery(sql),
    parameters : filters.parameters(),
  };
}

/**
 * @function find
 *
 * @description
 * This function filters the posting journal by query parameters passed in via
 * the options object.  If no query parameters are provided, the method will
 * return all items in the posting journal
 *
 * includeNonPosted
 * includeAggregates
 */
function find(options) {
  if (options.includeNonPosted && Boolean(Number(options.includeNonPosted))) {
    delete options.includeNonPosted;
    return naiveTransactionSearch(options, true);
  }

  return naiveTransactionSearch(options, false);
}

function postProcessFullTransactions(rows, includeNonPosted) {
  // get a list of unique record uuids
  const records = rows
    .map(row => row.record_uuid)
    .filter((value, idx, arr) => arr.indexOf(value) === idx);

  return find({ record_uuids : records, includeNonPosted });
}

/**
 * @method list
 *
 * @description
 * This function simply uses the find() method to filter the posting journal and
 * (optionally) the general ledger.  If the "showFullTransactions" option is
 * passed to the query string, the entire transaction matching the filter
 * parameters will be shown.
 */
function list(req, res, next) {
  // cache this the "nonposted" query in case in case we need to look up the
  // full transaction records.
  const { includeNonPosted, showFullTransactions } = req.query;
  find(req.query)
    .then(journalResults => {
      const hasEmptyResults = journalResults.length === 0;

      const hasFullTransactions = showFullTransactions &&
        Boolean(Number(showFullTransactions));

      // only do a second pass if we have data and have requested the full transaction
      // records
      if (!hasEmptyResults && hasFullTransactions) {
        return postProcessFullTransactions(journalResults, includeNonPosted);
      }

      return journalResults;
    })
    .then(rows => res.status(200).send(rows))
    .catch(next)
    .done();
}

/**
 * GET /journal/:record_uuid
 * send back a set of lines which have the same record_uuid the which provided by the user
 */
function getTransaction(req, res, next) {
  lookupTransaction(req.params.record_uuid)
    .then((transaction) => {
      res.status(200).json(transaction);
    })
    .catch(next)
    .done();
}

// @TODO(sfount) move edit transaction code to separate server controller - split editing process
//               up into smaller self contained methods
function editTransaction(req, res, next) {
  const REMOVE_JOURNAL_ROW = 'DELETE FROM posting_journal WHERE uuid = ?;';
  const UPDATE_JOURNAL_ROW = 'UPDATE posting_journal SET ? WHERE uuid = ?;';
  const INSERT_JOURNAL_ROW = 'INSERT INTO posting_journal SET ?;';
  const UPDATE_TRANSACTION_HISTORY = 'INSERT INTO transaction_history SET ?;';

  const transaction = db.transaction();
  const recordUuid = req.params.record_uuid;

  const rowsChanged = req.body.changed;
  const rowsAdded = req.body.added;
  const rowsRemoved = req.body.removed;

  let _transactionToEdit;
  let _fiscalYear;

  rowsRemoved.forEach(row => transaction.addQuery(REMOVE_JOURNAL_ROW, [db.bid(row.uuid)]));

  // verify that this transaction is NOT in the general ledger already
  // @FIXME(sfount) this logic needs to be updated when allowing super user editing
  lookupTransaction(recordUuid)
    .then((transactionToEdit) => {
      const { posted, trans_id } = transactionToEdit[0];

      // bind the current transaction under edit as "transactionToEdit"
      _transactionToEdit = transactionToEdit;

      // check the source (posted vs. non-posted) of the first transaction row
      if (posted) {
        throw new BadRequest(
          `Posted transactions cannot be edited.  Transaction ${trans_id} is already posted.`,
          'POSTING_JOURNAL.ERRORS.TRANSACTION_ALREADY_POSTED'
        );
      }

      // make sure that the user tools cannot simply remove all rows without going through
      // the deletion API
      const allRowsRemoved = (rowsAdded.length === 0 && rowsRemoved.length >= transactionToEdit.length);
      const singleRow = ((rowsAdded.length - rowsRemoved.length) + transactionToEdit.length) === 1;
      if (allRowsRemoved || singleRow) {
        throw new BadRequest(
          `Transaction ${trans_id} has too few rows!  A valid transaction must contain at least two rows.`,
          'POSTING_JOURNAL.ERRORS.TRANSACTION_MUST_CONTAIN_ROWS'
        );
      }

      // retrieve the transaction date
      const transDate = getTransactionDate(rowsChanged, transactionToEdit);
      return FiscalService.lookupFiscalYearByDate(transDate);
    })
    .then((fiscalYear) => {
      _fiscalYear = fiscalYear;

      if (fiscalYear.locked) {
        throw new BadRequest(
          `${fiscalYear.label} is closed and locked.  You cannot make transactions against it.`,
          'POSTING_JOURNAL.ERRORS.CLOSED_FISCAL_YEAR'
        );
      }

      // continue with editing - transform requested additional columns
      return transformColumns(rowsAdded, true, _transactionToEdit, fiscalYear);
    })
    .then((result) => {
      result.forEach((row) => {
        db.convert(row, ['uuid', 'record_uuid', 'entity_uuid', 'reference_uuid']);
        transaction.addQuery(INSERT_JOURNAL_ROW, [row]);
      });

      return transformColumns(rowsChanged, false, _transactionToEdit, _fiscalYear);
    })
    .then((result) => {
      _.each(result, (row, uid) => {
        db.convert(row, ['entity_uuid']);
        transaction.addQuery(UPDATE_JOURNAL_ROW, [row, db.bid(uid)]);
      });

      // record the transaction history once the transaction has been updated.
      const row = _transactionToEdit[0];
      const transactionHistory = {
        uuid : db.bid(uuid()),
        record_uuid : db.bid(row.record_uuid),
        user_id : req.session.user.id,
      };

      transaction.addQuery(UPDATE_TRANSACTION_HISTORY, [transactionHistory]);

      return transaction.execute();
    })
    .then(() => {
      // transaction changes written successfully - return latest version of transaction
      return lookupTransaction(recordUuid);
    })
    .then((updatedRows) => {
      res.status(200).json(updatedRows);
    })
    .catch(next)
    .done();

  // 1. make changes with update methods ('SET ?') etc.
  // 2. run changes through trial balance
  // 3. roll back transaction

  // edit transaction with uuid - uuid
}

// converts all valid posting journal editable columns into data representations
// returns valid errors for incorrect data
// @TODO Many requests are made vs. getting one look up table and using that - this can be greatly optimised
function transformColumns(rows, newRecord, transactionToEdit, setFiscalData) {
  const ACCOUNT_NUMBER_QUERY = 'SELECT id FROM account WHERE number = ?';
  const ENTITY_QUERY = 'SELECT uuid FROM entity_map WHERE text = ?';
  const REFERENCE_QUERY = 'SELECT uuid FROM document_map  WHERE text = ?';
  const EXCHANGE_RATE_QUERY = `
    SELECT ? * IF(enterprise.currency_id = ?, 1, GetExchangeRate(enterprise.id, ?, ?)) AS amount FROM enterprise
    JOIN project ON enterprise.id = project.enterprise_id WHERE project.id = ?;
  `;

  // these are global/shared properties of the current transaction
  // TODO(@jniles) - define these shared properties in an isomorphic way to share between
  // client and server.
  const projectId = transactionToEdit[0].project_id;
  const transactionDate = transactionToEdit[0].trans_date;
  const currencyId = transactionToEdit[0].currency_id;

  const databaseRequests = [];
  const databaseValues = [];
  const assignments = [];

  let promises = [];

  // this works on both the object provided from changes and the array from new
  // rows - that might be a hack
  _.each(rows, (row) => {
    // supports specific columns that can be edited on the client
    // accounts are required on new rows, business logic should be moved elsewhere
    if (newRecord && !row.account_number) {
      throw new BadRequest('Invalid accounts for journal rows', 'POSTING_JOURNAL.ERRORS.EDIT_INVALID_ACCOUNT');
    }

    if (row.account_number) {
      databaseRequests.push(ACCOUNT_NUMBER_QUERY);
      databaseValues.push([row.account_number]);
      assignments.push((result) => {
        if (!result.length) {
          throw new BadRequest('Invalid accounts for journal rows', 'POSTING_JOURNAL.ERRORS.EDIT_INVALID_ACCOUNT');
        }

        _.extend(row, { account_id : result[0].id });
        return result;
      });

      delete row.account_number;
    }

    if (row.account_name) {
      delete row.account_name;
    }

    if (row.account_label) {
      delete row.account_label;
    }

    if (row.hrEntity) {
      // reverse barcode lookup entity
      databaseRequests.push(ENTITY_QUERY);
      databaseValues.push([row.hrEntity]);

      assignments.push((result) => {
        if (!result.length) {
          throw new BadRequest('Invalid entity for journal rows', 'POSTING_JOURNAL.ERRORS.EDIT_INVALID_ENTITY');
        }

        _.extend(row, { entity_uuid : result[0].uuid });
        return result;
      });

      delete row.hrEntity;
    }

    if (row.hrReference) {
      // reverse barcode lookup entity
      databaseRequests.push(REFERENCE_QUERY);
      databaseValues.push([row.hrReference]);

      assignments.push((result) => {
        if (!result.length) {
          throw new BadRequest('Invalid reference for journal rows', 'POSTING_JOURNAL.ERRORS.EDIT_INVALID_REFERENCE');
        }

        row.reference_uuid = result[0].uuid;
        return result;
      });
      delete row.hrReference;
    }

    // NOTE: To update the amounts, we need to have the enterprise_id, currency_id, and date.
    // These are attained from the old transaction (transactionToEdit) or the changed transaction.

    if (row.debit_equiv) {
      // if the date has been updated, use the new date - otherwise default to the old transaction date
      const transDate = new Date(row.trans_date ? row.trans_date : transactionDate);

      databaseRequests.push(EXCHANGE_RATE_QUERY);
      databaseValues.push([row.debit_equiv, currencyId, currencyId, transDate, projectId]);

      assignments.push((result) => {
        const [{ amount }] = result;

        if (!amount) {
          throw new BadRequest(
            'Missing or corrupt exchange rate for rows',
            'POSTING_JOURNAL.ERRORS.MISSING_EXCHANGE_RATE'
          );
        }

        row.debit = amount;
      });
    }

    if (row.credit_equiv) {
      // if the date has been updated, use the new date - otherwise default to the old transaction date
      const transDate = new Date(row.trans_date ? row.trans_date : transactionDate);

      databaseRequests.push(EXCHANGE_RATE_QUERY);
      databaseValues.push([row.credit_equiv, currencyId, currencyId, transDate, projectId]);

      assignments.push((result) => {
        const [{ amount }] = result;

        if (!amount) {
          throw new BadRequest(
            'Missing or corrupt exchange rate for rows',
            'POSTING_JOURNAL.ERRORS.MISSING_EXCHANGE_RATE'
          );
        }
        row.credit = amount;
      });
    }

    // ensure date strings are processed correctly
    // @TODO standardise formatting vs. lookup behaviour
    if (row.trans_date) {
      row.trans_date = new Date(row.trans_date);

      // Assign the fiscal year value and the period each time the trans_date change
      row.fiscal_year_id = setFiscalData.fiscal_year_id;
      row.period_id = setFiscalData.id;
    }
  });

  promises = databaseRequests.map((request, index) =>
    db.exec(request, databaseValues[index])
      .then(results => assignments[index](results)));

  return q.all(promises)
    .then(() => rows);
}


/**
 * @method reverse
 *
 * @description
 * This is a generic wrapper for reversing any transaction in the posting
 * journal or general ledger.
 *
 * POST /journal/:uuid/reverse
 */
function reverse(req, res, next) {
  const voucherUuid = uuid();
  const recordUuid = db.bid(req.params.uuid);
  const params = [
    recordUuid,
    req.session.user.id,
    req.body.description,
    db.bid(voucherUuid),
  ];

  /**
   * Check already cancelled
   * Transaction type for cancelled operation is 10
   */
  const CANCELLED_ID = 10;
  const query = `
    SELECT uuid FROM voucher
    WHERE voucher.type_id = ${CANCELLED_ID} AND voucher.reference_uuid = ?
  `;

  // create and execute a transaction if necessary
  db.exec(query, [recordUuid])
    .then((rows) => {
      if (rows.length > 0) {
        // transaction already cancelled
        throw new BadRequest(
          'The transaction has been already cancelled',
          'POSTING_JOURNAL.ERRORS.MULTIPLE_CANCELLING'
        );
      }
      return db.exec('CALL ReverseTransaction(?, ?, ?, ?);', params);
    })
    .then(() => res.status(201).json({ uuid : voucherUuid }))
    .catch(next)
    .done();
}

/**
 * GET /JOURNAL/COUNT
 * Getting the number of transaction from the posting journal
 *
 */
function count(req, res, next) {
  const sql = `
    SELECT COUNT(DISTINCT posting_journal.trans_id) AS number_transactions FROM posting_journal;
  `;

  db.exec(sql)
    .then((rows) => {
      res.status(200).send(rows);
    })
    .catch(next);
}

/**
 * @function getTransactionDate
 *
 * @description
 * This function computes the date of the transaction from the submitted data.
 * It will prefer changed rows over the underlying transaction, if the user changed the trans_date.
 */
function getTransactionDate(changedRows = {}, oldRows) {
  // for some reason, changedRows is an object while all others are arrays.
  // we must convert it to an array.
  const changes = _.map(changedRows, row => row);

  const rows = [...oldRows, ...changes];
  return rows
    .filter(row => row.trans_date)
    .map(row => row.trans_date)
    .pop();
}

/**
 * @function getTransactionEditHistory
 *
 * @description
 * A lightweight function to scan the transaction_history and check if
 * a transaction has previously been edited.  If so, it pulls out the user
 * that edited it and return that record to the client.
 */
function getTransactionEditHistory(req, res, next) {
  const sql = `
    SELECT u.display_name, timestamp FROM transaction_history
    JOIN user AS u ON u.id = transaction_history.user_id
    WHERE record_uuid = ?;
  `;

  db.exec(sql, [db.bid(req.params.uuid)])
    .then(record => res.status(200).json(record))
    .catch(next)
    .done();
}


/**
 * PUT /journal/comments
 *
 * @function commentPostingJournal
 *
 * @description
 * This function will put a comment on both the posting journal and general ledger.
 *
 * @param {object} params - { uuids: [...], comment: '' }
 */
function commentPostingJournal(req, res, next) {
  const { uuids, comment } = req.body.params;
  const uids = uuids.map(db.bid);

  const journalUpdate = 'UPDATE posting_journal SET comment = ? WHERE uuid IN ?';
  const ledgerUpdate = 'UPDATE general_ledger SET comment = ? WHERE uuid IN ?';

  q.all([
    db.exec(journalUpdate, [comment, [uids]]),
    db.exec(ledgerUpdate, [comment, [uids]]),
  ])
    .then(() => {
      res.sendStatus(200);
    })
    .catch(next)
    .done();
}
