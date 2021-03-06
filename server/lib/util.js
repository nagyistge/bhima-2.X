/* eslint global-require:off, import/no-dynamic-require:off */

/**
 * @overview util
 *
 * @description
 * This module contains useful utility functions used throughout the server.
 *
 * @requires lodash
 * @requires q
 * @requires moment
 * @requires debug
 */

const _ = require('lodash');
const q = require('q');
const moment = require('moment');
const debug = require('debug')('util');

module.exports.take = take;
module.exports.loadModuleIfExists = requireModuleIfExists;
exports.dateFormatter = dateFormatter;
exports.resolveObject = resolveObject;

/**
 * @function take
 *
 * @description
 * Creates a filter to be passed to a Array.map() function.  This filter will
 * flatten an array of JSONs in to an array of arrays with values matching the
 * keys specified as arguments, in the order that they are specified.
 *
 * @returns {Function} filter - a filtering function to that will convert an
 *   object to an array with the given keys.
 *
 * @example
 * var _ = require('lodash');
 *
 * var array = [{
 *   id: 1,
 *   season: 'summer',
 * }, {
 *   id : 2,
 *   season : 'winter'
 * }, {
 *   id : 3,
 *   season : 'fall'
 * }];
 *
 * // take the ids from the JSON array
 * var filter = take('id');
 * var ids = _.flatMap(array, filter); // returns [1, 2, 3];
 * var ids = _.map(array, filter); // returns [ [1], [2], [3]];
 *
 * // take both the id and the season properties from the array
 * var filter = take('id', 'season');
 * var arrs = _.map(array, filter); // returns [[1, 'summer], [2, 'winter'], [3, 'fall']]
 */
function take(...keys) {
  // get the arguments as an array
  // return the filter function
  return object => (keys.map(key => object[key]));
}

/**
 * @method requireModuleIfExists
 * @description load a module if it exists
 */
function requireModuleIfExists(moduleName) {
  try {
    require(moduleName);
    debug(`Dynamically loaded ${moduleName}.`);
  } catch (err) {
    return false;
  }
  return true;
}

/**
 * @function resolveObject
 *
 * @description
 * This utility takes in an object of promise queries and returns the object
 * with all values resolved when all promises have settled.  If any one is
 * rejected, the promise is rejected.
 *
 * @param {Object} object - this is the object of keys mapped to promise
 *   values.
 * @returns {Promise} - one all promises resolve, the same object mapped to
 */
function resolveObject(object) {
  const settled = {};

  return q.all(_.values(object))
    .then((results) => {
      _.keys(object).forEach((key, index) => { settled[key] = results[index]; });
      return settled;
    });
}

/**
 * @method dateFormatter
 *
 * @description
 * Accepts an object of key/value pairs. Returns the same object with all values
 * that are dates converted to a standard format.
 */
function dateFormatter(rows, dateFormat) {
  const DATE_FORMAT = dateFormat || 'YYYY-MM-DD HH:mm:ss';

  _.forEach(rows, element => {
    _.forEach(element, (value, key) => {
      if (_.isDate(element[key])) {
        element[key] = moment(element[key]).format(DATE_FORMAT);
      }
    });
  });

  return rows;
}
