'use strict';

var assert = require('assert');
var yaml = require('../..');

function createMergeChain(count) {
  var lines = [ 'a0: &a0 { k0: 0 }' ];
  var i;

  for (i = 1; i < count; i++) {
    lines.push('a' + i + ': &a' + i + ' { <<: *a' + (i - 1) + ', k' + i + ': ' + i + ' }');
  }

  lines.push('b: *a' + (count - 1));
  return lines.join('\n') + '\n';
}

// `a: &a { k0: 0, ... }` followed by `b: { <<: [ *a, *a, ... ] }`. Every
// repetition resolves to the very same node, so all of them but the first are
// redundant work.
function createRepeatedMergeAlias(repetitions, keys) {
  var pairs = [];
  var refs = [];
  var i;

  for (i = 0; i < keys; i++) {
    pairs.push('k' + i + ': ' + i);
  }

  for (i = 0; i < repetitions; i++) {
    refs.push('*a');
  }

  return 'a: &a { ' + pairs.join(', ') + ' }\nb: { <<: [ ' + refs.join(', ') + ' ] }\n';
}

function emptyMergeSource() {
  return '{}';
}

function singleKeyMergeSource(i) {
  return '{ k' + i + ': ' + i + ' }';
}

// `a0: &a0 <body>` ... followed by `z: { <<: [ *a0, *a1, ... ] }`, with the whole
// alias list repeated `passes` times. Every source is distinct, which is the
// shape that an unbounded dedupe scan would turn quadratic.
function createDistinctMergeSources(count, passes, body) {
  var lines = [];
  var refs = [];
  var pass;
  var i;

  for (i = 0; i < count; i++) {
    lines.push('a' + i + ': &a' + i + ' ' + body(i));
  }

  for (pass = 0; pass < passes; pass++) {
    for (i = 0; i < count; i++) {
      refs.push('*a' + i);
    }
  }

  lines.push('z: { <<: [ ' + refs.join(', ') + ' ] }');
  return lines.join('\n') + '\n';
}

// 1000 repetitions of a 100 key mapping cost 100000 merge keys when the sources
// are not deduped, which is way beyond the default limit. Deduped, only the 100
// keys of the single distinct source are ever copied.
function assertMergeDedupe(impl) {
  var deduped = impl.safeLoad(createRepeatedMergeAlias(1000, 100));

  assert.strictEqual(Object.keys(deduped.b).length, 100);
  assert.strictEqual(deduped.b.k0, 0);
  assert.strictEqual(deduped.b.k99, 99);
}

suite('loader parameters', function () {
  var testStr = 'test: 1 \ntest: 2';
  var expected =  [ { test: 2 } ];
  var result;

  test('loadAll(input, options)', function () {
    result = yaml.loadAll(testStr, { json: true });
    assert.deepEqual(result, expected);

    result = [];
    yaml.loadAll(testStr, function (doc) {
      result.push(doc);
    }, { json: true });
    assert.deepEqual(result, expected);
  });

  test('loadAll(input, null, options)', function () {
    result = yaml.loadAll(testStr, null, { json: true });
    assert.deepEqual(result, expected);

    result = [];
    yaml.loadAll(testStr, function (doc) {
      result.push(doc);
    }, { json: true });
    assert.deepEqual(result, expected);
  });

  test('safeLoadAll(input, options)', function () {
    result = yaml.safeLoadAll(testStr, { json: true });
    assert.deepEqual(result, expected);

    result = [];
    yaml.safeLoadAll(testStr, function (doc) {
      result.push(doc);
    }, { json: true });
    assert.deepEqual(result, expected);
  });

  test('safeLoadAll(input, null, options)', function () {
    result = yaml.safeLoadAll(testStr, null, { json: true });
    assert.deepEqual(result, expected);

    result = [];
    yaml.safeLoadAll(testStr, function (doc) {
      result.push(doc);
    }, { json: true });
    assert.deepEqual(result, expected);
  });

  test('maxTotalMergeKeys - caps total merge keys', function () {
    function merge(n) {
      var anchors = [];
      var refs = [];
      var i;

      for (i = 0; i < n; i++) {
        anchors.push('- &x' + i + ' {a' + i + ': ' + i + '}');
        refs.push('*x' + i);
      }

      return anchors.join('\n') + '\n- <<: [' + refs.join(', ') + ']\n';
    }

    assert.doesNotThrow(function () {
      yaml.safeLoad(merge(3), { maxTotalMergeKeys: 5 });
    });
    assert.throws(function () {
      yaml.safeLoad(merge(3), { maxTotalMergeKeys: 2 });
    }, /maxTotalMergeKeys/);
    assert.doesNotThrow(function () {
      yaml.safeLoad(merge(3), { maxTotalMergeKeys: -1 });
    });

    result = yaml.safeLoad(createMergeChain(150), { maxTotalMergeKeys: -1 });
    assert.strictEqual(Object.keys(result.b).length, 150);
  });

  // Existing keys are never overridden on merge, so every repetition of the same
  // alias in a merge sequence is redundant work. Undeduped, `<<: [ *a, *a, ... ]`
  // scales with repetitions * keys, which lets a tiny document burn an unbounded
  // amount of CPU.
  test('merge aliases - repeated aliases of the same node are deduped', function () {
    assertMergeDedupe(yaml);

    // Same document through the non-safe entry points.
    result = yaml.load(createRepeatedMergeAlias(1000, 100));
    assert.strictEqual(Object.keys(result.b).length, 100);

    result = yaml.loadAll(createRepeatedMergeAlias(1000, 100));
    assert.strictEqual(Object.keys(result[0].b).length, 100);

    // The shape reported for this issue: an ~100 KB document with 8000 keys
    // aliased 8000 times. Undeduped that is 64000000 merge keys; deduped it is
    // exactly the 8000 keys of the one distinct source.
    result = yaml.safeLoad(createRepeatedMergeAlias(8000, 8000));
    assert.strictEqual(Object.keys(result.b).length, 8000);
    assert.strictEqual(result.b.k7999, 7999);
  });

  test('merge aliases - distinct sources are all merged, first one wins', function () {
    // Dedupe must not drop sources that merely repeat around a distinct one.
    result = yaml.safeLoad([
      'a: &a { k1: 1 }',
      'b: &b { k2: 2 }',
      'c: &c { k3: 3 }',
      'd: { <<: [ *a, *b, *a, *c, *b, *a ] }',
      ''
    ].join('\n'));
    assert.deepEqual(result.d, { k1: 1, k2: 2, k3: 3 });

    // Merge precedence is unchanged: the earliest source of a key wins.
    result = yaml.safeLoad([
      'a: &a { k: from-a }',
      'b: &b { k: from-b }',
      'c: { <<: [ *a, *b, *a ] }',
      ''
    ].join('\n'));
    assert.strictEqual(result.c.k, 'from-a');

    // An explicit key still overrides everything merged into the node.
    result = yaml.safeLoad([
      'a: &a { k: from-a }',
      'b: { <<: [ *a, *a ], k: explicit }',
      ''
    ].join('\n'));
    assert.strictEqual(result.b.k, 'explicit');
  });

  // The dedupe only remembers a bounded window of sources, so a merge sequence
  // built entirely out of DISTINCT sources stays linear instead of paying a scan
  // that grows with the sequence. Empty sources copy no keys at all, so
  // maxTotalMergeKeys puts no bound on that shape - only the window does.
  test('merge aliases - many distinct sources stay linear and merge correctly', function () {
    result = yaml.safeLoad(createDistinctMergeSources(2000, 1, emptyMergeSource));
    assert.deepEqual(result.z, {});

    // Far more distinct sources than the window, and every one must be merged.
    result = yaml.safeLoad(createDistinctMergeSources(2000, 1, singleKeyMergeSource));
    assert.strictEqual(Object.keys(result.z).length, 2000);
    assert.strictEqual(result.z.k0, 0);
    assert.strictEqual(result.z.k1999, 1999);
  });

  test('merge aliases - correctness does not depend on the dedupe window', function () {
    // Two full sweeps over 200 distinct sources: the second occurrence of a
    // source that fell outside the window is not deduped, so it gets merged
    // again - which must be a no-op rather than change the result.
    result = yaml.safeLoad(createDistinctMergeSources(200, 2, singleKeyMergeSource));
    assert.strictEqual(Object.keys(result.z).length, 200);
    assert.strictEqual(result.z.k0, 0);
    assert.strictEqual(result.z.k100, 100);
    assert.strictEqual(result.z.k199, 199);

    // Merge precedence is unaffected too: repetitions of a later source never
    // take a key from an earlier one, deduped or not.
    var refs = [];
    var i;

    for (i = 0; i < 200; i++) {
      refs.push('*second');
    }

    result = yaml.safeLoad([
      'first: &first { k: from-first }',
      'second: &second { k: from-second }',
      'z: { <<: [ *first, ' + refs.join(', ') + ' ] }',
      ''
    ].join('\n'));
    assert.strictEqual(result.z.k, 'from-first');
  });

  test('merge aliases - redundant work escaping the window is still capped', function () {
    // Fill the dedupe window with distinct sources first, so the repeated wide
    // alias that follows is never remembered and does get re-merged every time.
    // That residual work stays bounded by maxTotalMergeKeys.
    var lines = [];
    var refs = [];
    var keys = [];
    var i;

    for (i = 0; i < 200; i++) {
      lines.push('e' + i + ': &e' + i + ' {}');
      refs.push('*e' + i);
      keys.push('k' + i + ': ' + i);
    }

    lines.push('wide: &wide { ' + keys.join(', ') + ' }');

    for (i = 0; i < 200; i++) {
      refs.push('*wide');
    }

    assert.throws(function () {
      yaml.safeLoad(lines.join('\n') + '\nz: { <<: [ ' + refs.join(', ') + ' ] }\n');
    }, /merge keys exceeded maxTotalMergeKeys \(10000\)/);
  });

  test('merge aliases - non-mapping sources are still rejected', function () {
    assert.throws(function () {
      yaml.safeLoad('a: &a some-scalar\nb: { <<: [ *a, *a ] }\n');
    }, /the provided source object is unacceptable/);
  });

  test('safeLoadAll - maxTotalMergeKeys is shared across all documents', function () {
    var src = [
      '---',
      'a: &a { k1: 1, k2: 2 }',
      'b: { <<: *a }',
      '---',
      'a: &a { k1: 1, k2: 2 }',
      'b: { <<: *a }',
      ''
    ].join('\n');

    assert.doesNotThrow(function () {
      yaml.safeLoadAll(src, { maxTotalMergeKeys: 4 });
    });
    assert.throws(function () {
      yaml.safeLoadAll(src, { maxTotalMergeKeys: 3 });
    }, /maxTotalMergeKeys/);
  });
});
