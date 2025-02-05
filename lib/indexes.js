var BinarySearchTree = require('@yetzt/binary-search-tree').AVLTree
  , document = require('./document')
  , _ = require('underscore')
  , util = require('util')
  ;

/**
 * Two indexed pointers are equal iif they point to the same place
 */
function checkValueEquality (a, b) {
  return a === b;
}

/**
 * Type-aware projection
 */
function projectForUnique (elt) {
  if (elt === null) { return '$null'; }
  if (typeof elt === 'string') { return '$string' + elt; }
  if (typeof elt === 'boolean') { return '$boolean' + elt; }
  if (typeof elt === 'number') { return '$number' + elt; }
  if (util.isArray(elt)) { return '$date' + elt.getTime(); }
  
  return elt;   // Arrays and ob
}

/**
 * Get dot values for either a bunch of fields or just one.
 */
function getDotValues (doc, fields) {
  var field, key, i, len;

  if (util.isArray(fields)) {
    key = {};
    for (i = 0, len = fields.length; i < len; i++) {
      field = fields[i];
      key[field] = document.getDotValue(doc, field);
    }
    return key;
  } else {
    return document.getDotValue(doc, fields);
  }
}


/**
 * Create a new index
 * All methods on an index guarantee that either the whole operation was successful and the index changed
 * or the operation was unsuccessful and an error is thrown while the index is unchanged
 * @param {String} options.fieldName On which field should the index apply (can use dot notation to index on sub fields)
 * @param {Boolean} options.unique Optional, enforce a unique constraint (default: false)
 * @param {Boolean} options.sparse Optional, allow a sparse index (we can have documents for which fieldName is undefined) (default: false)
 */
function Index (options) {
  this.fieldName = options.fieldName;
  this.unique = options.unique || false;
  this.sparse = options.sparse || false;

  var compareFunc = util.isArray(this.fieldName) ? document.compoundCompareThings(this.fieldName) : document.compareThings;
  this.treeOptions = { unique: this.unique, compareKeys: compareFunc, checkValueEquality: checkValueEquality };
  
  this.reset();   // No data in the beginning
}


/**
 * Reset an index
 */
Index.prototype.reset = function () {
  this.tree = new BinarySearchTree(this.treeOptions);
  this.ready = false;
};


/**
 * Insert a new document in the index
 * If an array is passed, we insert all its elements (if one insertion fails the index is not modified)
 * O(log(n))
 */
Index.prototype.insert = function (doc) {
  var key, val, self = this
    , keys, i, failingI, error
    ;

  if (util.isArray(doc)) { this.insertMultipleDocs(doc); return; }
  key = getDotValues(doc, this.fieldName);

  //if (! doc._id) throw "Index.insert: document should contain _id";

  // We don't index documents that don't contain the field if the index is sparse
  if ((key === undefined || _.isEmpty(key)) && this.sparse) { return; }

  if (!util.isArray(key)) {
    this.tree.insert(key, doc._id);
  } else {
    // If an insert fails due to a unique constraint, roll back all inserts before it
    keys = _.uniq(key, projectForUnique);

    for (i = 0; i < keys.length; i += 1) {
      try {
        this.tree.insert(keys[i], doc._id);
      } catch (e) {
        error = e;
        failingI = i;
        break;
      }
    }
    
    if (error) {
      for (i = 0; i < failingI; i += 1) {
        this.tree.delete(keys[i], doc._id);
      }
      
      throw error;
    }
  }
};


/**
 * Insert an array of documents in the index
 * If a constraint is violated, the changes should be rolled back and an error thrown
 *
 * @API private
 */
Index.prototype.insertMultipleDocs = function (docs) {
  var i, error, failingI;

  for (i = 0; i < docs.length; i += 1) {
    try {
      this.insert(docs[i]);
    } catch (e) {
      error = e;
      failingI = i;
      break;
    }
  }

  if (error) {
    for (i = 0; i < failingI; i += 1) {
      this.remove(docs[i]);
    }

    throw error;
  }
};


/**
 * Remove a document from the index
 * If an array is passed, we remove all its elements
 * The remove operation is safe with regards to the 'unique' constraint
 * O(log(n))
 */
Index.prototype.remove = function (doc) {
  var key, self = this;

  if (util.isArray(doc)) { doc.forEach(function (d) { self.remove(d); }); return; }

  key = getDotValues(doc, this.fieldName);

  if ((key === undefined || _.isEmpty(key)) && this.sparse) { return; }

  if (!util.isArray(key)) {
    this.tree.delete(key, doc._id);
  } else {
    _.uniq(key, projectForUnique).forEach(function (_key) {
      self.tree.delete(_key, doc._id);
    });
  }
};


/**
 * Update a document in the index
 * If a constraint is violated, changes are rolled back and an error thrown
 * Naive implementation, still in O(log(n))
 */
Index.prototype.update = function (oldDoc, newDoc) {
  if (util.isArray(oldDoc)) { this.updateMultipleDocs(oldDoc); return; }

  this.remove(oldDoc);

  try {
    this.insert(newDoc);
  } catch (e) {
    this.insert(oldDoc);
    throw e;
  }
};


/**
 * Update multiple documents in the index
 * If a constraint is violated, the changes need to be rolled back
 * and an error thrown
 * @param {Array of oldDoc, newDoc pairs} pairs
 *
 * @API private
 */
Index.prototype.updateMultipleDocs = function (pairs) {
  var i, failingI, error;

  for (i = 0; i < pairs.length; i += 1) {
    if (pairs[i].oldDoc) this.remove(pairs[i].oldDoc);
  }

  for (i = 0; i < pairs.length; i += 1) {
    try {
      if (pairs[i].newDoc) this.insert(pairs[i].newDoc);
    } catch (e) {
      error = e;
      failingI = i;
      break;
    }
  }

  // If an error was raised, roll back changes in the inverse order
  if (error) {
    for (i = 0; i < failingI; i += 1) {
      // no newDoc scenario might happen with .save on a unique constraint
      if (pairs[i].newDoc) this.remove(pairs[i].newDoc);
    }

    for (i = 0; i < pairs.length; i += 1) {
      if (pairs[i].oldDoc) this.insert(pairs[i].oldDoc);
    }

    throw error;
  }
};


/**
 * Revert an update
 */
Index.prototype.revertUpdate = function (oldDoc, newDoc) {
  var revert = [];

  if (!util.isArray(oldDoc)) {
    this.update(newDoc, oldDoc);
  } else {
    oldDoc.forEach(function (pair) {
      revert.push({ oldDoc: pair.newDoc, newDoc: pair.oldDoc });
    });
    this.update(revert);
  }
};


// Append all elements in toAppend to array
function append (array, toAppend) {
  var i;

  for (i = 0; i < toAppend.length; i += 1) {
    array.push(toAppend[i]);
  }
}


/**
 * Get all documents in index whose key match value (if it is a Thing) or one of the elements of value (if it is an array of Things)
 * @param {Thing} value Value to match the key against
 * @return {Array of documents}
 */
Index.prototype.getMatching = function (value) {
  var res, self = this;

  if (!util.isArray(value)) {
    return this.tree.search(value);
  } else {
    res = [];
    value.forEach(function (v) { append(res, self.getMatching(v)); });
    return res;
  }
};


/**
 * Get all documents in index whose key is between bounds are they are defined by query
 * Documents are sorted by key
 * @param {Query} query
 * @return {Array of documents}
 */
Index.prototype.getBetweenBounds = function (query) {
  return this.tree.betweenBounds(query);
};


/**
 * Get all elements in the index
 * @return {Array of documents}
 */
Index.prototype.getAll = function (matcher) {
  var res = [];

  this.tree.executeOnEveryNode(function (node) {
    if (typeof(matcher)=="function" && !matcher(node)) return;

    var i;

    for (i = 0; i < node.data.length; i += 1) {
      res.push(node.data[i]);
    }
  });

  return res;
};



// Interface
module.exports = Index;
