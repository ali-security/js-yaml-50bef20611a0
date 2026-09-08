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

// `a0: &a0 <body>` ... followed by `z: { <<: [ *a0, *a1, ... ] }`. Every source
// is distinct, which is the shape that an unbounded dedupe scan would turn
// quadratic.
function createDistinctMergeSources(count, body) {
  var lines = [];
  var refs = [];
  var i;

  for (i = 0; i < count; i++) {
    lines.push('a' + i + ': &a' + i + ' ' + body(i));
    refs.push('*a' + i);
  }

  lines.push('z: { <<: [ ' + refs.join(', ') + ' ] }');
  return lines.join('\n') + '\n';
}

// The same `count` distinct sources merged into each of `keys` separate mapping
// keys `z0` ... `z<keys - 1>`. Every individual merge sequence stays within the
// accepted merge sequence size, yet the document as a whole performs
// `count * keys` merges - the dedupe window of one key never carries over to the
// next one, so every source really is merged again for every key.
function createManySequenceMerges(count, keys, body) {
  var lines = [];
  var refs = [];
  var i;

  for (i = 0; i < count; i++) {
    lines.push('a' + i + ': &a' + i + ' ' + body(i));
    refs.push('*a' + i);
  }

  for (i = 0; i < keys; i++) {
    lines.push('z' + i + ': { <<: [ ' + refs.join(', ') + ' ] }');
  }

  return lines.join('\n') + '\n';
}

// 100 repetitions of a 200 key mapping cost 20100 merge units when the sources
// are not deduped, which is way beyond the default limit. Deduped, only the one
// distinct source and its 200 keys are ever charged.
function assertMergeDedupe(impl) {
  var deduped = impl.safeLoad(createRepeatedMergeAlias(100, 200));

  assert.strictEqual(Object.keys(deduped.b).length, 200);
  assert.strictEqual(deduped.b.k0, 0);
  assert.strictEqual(deduped.b.k199, 199);
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

  // Every merge source is charged one unit for itself plus one unit per key it
  // is scanned for, so the three single key sources below cost six units.
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
      yaml.safeLoad(merge(3), { maxTotalMergeKeys: 6 });
    });
    assert.throws(function () {
      yaml.safeLoad(merge(3), { maxTotalMergeKeys: 5 });
    }, /maxTotalMergeKeys/);
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
    result = yaml.load(createRepeatedMergeAlias(100, 200));
    assert.strictEqual(Object.keys(result.b).length, 200);

    result = yaml.loadAll(createRepeatedMergeAlias(100, 200));
    assert.strictEqual(Object.keys(result[0].b).length, 200);

    // The shape reported for this issue, with the alias list brought down to a
    // merge sequence size the loader accepts: a mapping of 8000 keys aliased 100
    // times. Undeduped that is 800100 merge units; deduped it is exactly the one
    // distinct source plus its 8000 keys.
    result = yaml.safeLoad(createRepeatedMergeAlias(100, 8000));
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
  // that grows with the sequence. Every one of those sources must still be
  // merged, and every one of them - even an empty one - is charged.
  test('merge aliases - many distinct sources stay linear and merge correctly', function () {
    result = yaml.safeLoad(createDistinctMergeSources(100, emptyMergeSource));
    assert.deepEqual(result.z, {});

    // More distinct sources than the dedupe window, and every one is merged.
    result = yaml.safeLoad(createDistinctMergeSources(100, singleKeyMergeSource));
    assert.strictEqual(Object.keys(result.z).length, 100);
    assert.strictEqual(result.z.k0, 0);
    assert.strictEqual(result.z.k99, 99);

    // The window is per merge sequence, so spreading the same alias list over
    // many mapping keys merges every source again for every key: 2500 merges
    // costing 5000 units here, all of them well inside the default limit.
    result = yaml.safeLoad(createManySequenceMerges(100, 25, singleKeyMergeSource));
    assert.strictEqual(Object.keys(result.z0).length, 100);
    assert.strictEqual(Object.keys(result.z24).length, 100);
    assert.strictEqual(result.z24.k99, 99);
  });

  test('merge aliases - correctness does not depend on the dedupe window', function () {
    // 70 distinct sources, then the last six of them repeated. Those six fell
    // outside the 64 entry dedupe window, so they were never remembered and the
    // repetitions really are merged again - which must be a no-op rather than
    // change the result.
    var lines = [];
    var refs = [];
    var pass;
    var i;

    for (i = 0; i < 70; i++) {
      lines.push('a' + i + ': &a' + i + ' { k' + i + ': ' + i + ' }');
      refs.push('*a' + i);
    }

    for (pass = 0; pass < 5; pass++) {
      for (i = 64; i < 70; i++) {
        refs.push('*a' + i);
      }
    }

    lines.push('z: { <<: [ ' + refs.join(', ') + ' ] }');

    result = yaml.safeLoad(lines.join('\n') + '\n');
    assert.strictEqual(Object.keys(result.z).length, 70);
    assert.strictEqual(result.z.k0, 0);
    assert.strictEqual(result.z.k64, 64);
    assert.strictEqual(result.z.k69, 69);

    // Merge precedence is unaffected too: repetitions of a later source never
    // take a key from an earlier one, deduped or not.
    refs = [];

    for (i = 0; i < 99; i++) {
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
    // Fill the dedupe window with 64 distinct sources first, so the repeated
    // wide alias that follows is never remembered and does get re-merged every
    // time. That residual work stays bounded by maxTotalMergeKeys.
    var lines = [];
    var refs = [];
    var keys = [];
    var i;

    for (i = 0; i < 64; i++) {
      lines.push('e' + i + ': &e' + i + ' {}');
      refs.push('*e' + i);
    }

    for (i = 0; i < 500; i++) {
      keys.push('k' + i + ': ' + i);
    }

    lines.push('wide: &wide { ' + keys.join(', ') + ' }');

    for (i = 0; i < 36; i++) {
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

  // A merge source that folds no key at all - `{}` - still costs a full pass
  // through the merge machinery, but used to be charged nothing because only the
  // keys copied out of a source were counted. Distinct empty mappings cannot be
  // deduped either, since every one of them is its own node, so a short document
  // could drive an unbounded number of merges while never moving the counter.
  // Every source is charged one unit for itself now, empty or not.
  test('merge aliases - empty merge sources are charged against maxTotalMergeKeys', function () {
    // 100 empty sources merged into each of 200 mapping keys: 20000 merges that
    // copy no key whatsoever.
    var emptySources = createManySequenceMerges(100, 200, emptyMergeSource);
    var arr = [];
    var targets = [];
    var i;

    assert.throws(function () {
      yaml.safeLoad(emptySources);
    }, /merge keys exceeded maxTotalMergeKeys \(10000\)/);

    assert.throws(function () {
      yaml.load(emptySources);
    }, /merge keys exceeded maxTotalMergeKeys \(10000\)/);

    assert.throws(function () {
      yaml.safeLoadAll(emptySources);
    }, /merge keys exceeded maxTotalMergeKeys \(10000\)/);

    // An explicit limit bounds the very same shape.
    assert.throws(function () {
      yaml.safeLoad(createManySequenceMerges(100, 20, emptyMergeSource), { maxTotalMergeKeys: 100 });
    }, /merge keys exceeded maxTotalMergeKeys \(100\)/);

    // A single empty source costs exactly one unit.
    assert.doesNotThrow(function () {
      yaml.safeLoad('a: &a {}\nb: { <<: [ *a ] }\n', { maxTotalMergeKeys: 1 });
    });
    assert.throws(function () {
      yaml.safeLoad('a: &a {}\nb: { <<: [ *a ] }\n', { maxTotalMergeKeys: 0 });
    }, /merge keys exceeded maxTotalMergeKeys \(0\)/);

    // Opting out still opts out, and merging empty sources leaves the target
    // untouched.
    result = yaml.safeLoad(emptySources, { maxTotalMergeKeys: -1 });
    assert.deepEqual(result.z0, {});
    assert.deepEqual(result.z199, {});

    // Well inside the limit the same shape loads without complaining.
    result = yaml.safeLoad(createManySequenceMerges(100, 50, emptyMergeSource));
    assert.deepEqual(result.z0, {});
    assert.deepEqual(result.z49, {});

    // The shape reported for this issue, scaled down to a merge sequence the
    // loader accepts: ONE aliased sequence of 100 empty mappings merged into
    // every item of a 200 item block sequence. The dedupe is per merge, so all
    // 100 sources are merged again for every item - 20000 merges, not one of
    // which copies a key, off a document of a few kilobytes.
    for (i = 0; i < 100; i++) {
      arr.push('{}');
    }

    for (i = 0; i < 200; i++) {
      targets.push('  - <<: *arr');
    }

    assert.throws(function () {
      yaml.safeLoad('arr: &arr [ ' + arr.join(', ') + ' ]\ntargets:\n' + targets.join('\n') + '\n');
    }, /merge keys exceeded maxTotalMergeKeys \(10000\)/);
  });

  // Charging every source bounds the total amount of merging, but a single
  // absurdly long merge sequence is a shape no real document has, so it is
  // refused outright instead of being merged up to the limit.
  test('merge aliases - abnormally large merge sequences are refused', function () {
    var sources = [];
    var refs = [];
    var bomb = [];
    var target = [];
    var i;

    for (i = 0; i < 100; i++) {
      sources.push('{}');
      refs.push('*a');
    }

    // Exactly at the accepted size, both as an aliased sequence of mappings ...
    assert.doesNotThrow(function () {
      yaml.safeLoad('arr: &arr [ ' + sources.join(', ') + ' ]\nz: { <<: *arr }\n');
    });
    // ... and as an inline sequence of aliases.
    assert.doesNotThrow(function () {
      yaml.safeLoad('a: &a { k: 1 }\nz: { <<: [ ' + refs.join(', ') + ' ] }\n');
    });

    sources.push('{}');
    refs.push('*a');

    // One source past it, both shapes are rejected. The repeated alias would be
    // deduped down to a single merge, so its size alone is what is refused.
    assert.throws(function () {
      yaml.safeLoad('arr: &arr [ ' + sources.join(', ') + ' ]\nz: { <<: *arr }\n');
    }, /abnormal merge sequence size/);
    assert.throws(function () {
      yaml.safeLoad('a: &a { k: 1 }\nz: { <<: [ ' + refs.join(', ') + ' ] }\n');
    }, /abnormal merge sequence size/);

    // The reported proof of concept at its full size: a sequence of 20000 empty
    // mappings, merged through an alias into each of 20000 sequence items.
    // Unbounded that is 4e8 merges - every one of them copying nothing - for a
    // document of a few hundred kilobytes. Here the sequence size alone stops it
    // on the very first item.
    for (i = 0; i < 20000; i++) {
      bomb.push('{}');
      target.push('  - <<: *arr');
    }

    assert.throws(function () {
      yaml.safeLoad('arr: &arr [ ' + bomb.join(', ') + ' ]\ntargets:\n' + target.join('\n') + '\n');
    }, /abnormal merge sequence size/);
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
      yaml.safeLoadAll(src, { maxTotalMergeKeys: 6 });
    });
    assert.throws(function () {
      yaml.safeLoadAll(src, { maxTotalMergeKeys: 5 });
    }, /maxTotalMergeKeys/);
    assert.throws(function () {
      yaml.safeLoadAll(src, { maxTotalMergeKeys: 3 });
    }, /maxTotalMergeKeys/);
  });
});
