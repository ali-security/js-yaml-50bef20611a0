'use strict';


var assert = require('assert');
var yaml   = require('../../');


var _hasOwnProperty = Object.prototype.hasOwnProperty;

// Big enough to take quadratic time when the resolver dedupes keys with a
// linear scan, small enough to stay well inside the default mocha timeout
// once the dedupe is done with a hash lookup.
var LARGE_OMAP_SIZE = 200000;


function buildLargeOmap(count) {
  var lines = [ 'omap: !!omap' ], index;

  for (index = 0; index < count; index += 1) {
    lines.push('  - key' + index + ': ' + index);
  }

  return lines.join('\n') + '\n';
}


suite('Omap resolving', function () {

  test('should resolve a big omap without quadratic slowdown', function () {
    var result = yaml.load(buildLargeOmap(LARGE_OMAP_SIZE)).omap;

    assert.strictEqual(result.length, LARGE_OMAP_SIZE);
    assert.strictEqual(result[0].key0, 0);
    assert.strictEqual(result[LARGE_OMAP_SIZE - 1]['key' + (LARGE_OMAP_SIZE - 1)], LARGE_OMAP_SIZE - 1);
  });

  test('should reject duplicated keys inside an omap', function () {
    assert.throws(function () {
      yaml.load('omap: !!omap\n  - foo: 1\n  - bar: 2\n  - foo: 3\n');
    }, yaml.YAMLException);
  });

  test('should reject duplicated __proto__ keys inside an omap', function () {
    assert.throws(function () {
      yaml.load('omap: !!omap\n  - __proto__: 1\n  - __proto__: 2\n');
    }, yaml.YAMLException);
  });

  test('should resolve an omap with a __proto__ key', function () {
    var result = yaml.load('omap: !!omap\n  - __proto__: 1\n  - foo: 2\n').omap;

    assert.strictEqual(result.length, 2);
    assert.strictEqual(Object.getPrototypeOf(result[0]), Object.prototype);
    assert.deepEqual(Object.keys(result[0]), [ '__proto__' ]);
    assert.strictEqual(_hasOwnProperty.call(result[0], '__proto__'), true);
    assert.strictEqual(result[1].foo, 2);
  });

  test('should resolve an omap with keys inherited from Object.prototype', function () {
    var result = yaml.load('omap: !!omap\n  - toString: 1\n  - hasOwnProperty: 2\n  - constructor: 3\n').omap;

    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0].toString, 1);
    assert.strictEqual(result[1].hasOwnProperty, 2);
    assert.strictEqual(result[2].constructor, 3);
  });
});
