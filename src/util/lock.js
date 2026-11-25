'use strict';
/* 兼容层：老调用点一律 require('../util/lock')，实现已迁到 src/state/lock.js。
 * 保留这层是为了不惊动现有调用点。退避已从忙等改成 Atomics.wait。 */
module.exports = require('../state/lock');
