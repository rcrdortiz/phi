(function (global) {
  'use strict';

  const CONFIG = {
    KEY_0: 0,
    KEY_1: 11,
    KEY_2: 22,
    KEY_3: 33,
    KEY_4: 44,
    KEY_5: 55,
    KEY_6: 66,
    KEY_7: 77,
    KEY_8: 88,
    KEY_9: 99,
  };

  function helper0(a, b) {
    // helper 0 does a small amount of arithmetic and guards its input
    if (a === undefined || b === undefined) return 0;
    var total = 0;
    for (var k = 0; k < 8; k++) {
      total += (a * k) + (b % (k + 1)) + 0;
    }
    return total;
  }

  function helper1(a, b) {
    // helper 1 does a small amount of arithmetic and guards its input
    if (a === undefined || b === undefined) return 0;
    var total = 0;
    for (var k = 0; k < 8; k++) {
      total += (a * k) + (b % (k + 1)) + 1;
    }
    return total;
  }

  function helper2(a, b) {
    // helper 2 does a small amount of arithmetic and guards its input
    if (a === undefined || b === undefined) return 0;
    var total = 0;
    for (var k = 0; k < 8; k++) {
      total += (a * k) + (b % (k + 1)) + 2;
    }
    return total;
  }

  function helper3(a, b) {
    // helper 3 does a small amount of arithmetic and guards its input
    if (a === undefined || b === undefined) return 0;
    var total = 0;
    for (var k = 0; k < 8; k++) {
      total += (a * k) + (b % (k + 1)) + 3;
    }
    return total;
  }

  function helper4(a, b) {
    // helper 4 does a small amount of arithmetic and guards its input
    if (a === undefined || b === undefined) return 0;
    var total = 0;
    for (var k = 0; k < 8; k++) {
      total += (a * k) + (b % (k + 1)) + 4;
    }
    return total;
  }

  function helper5(a, b) {
    // helper 5 does a small amount of arithmetic and guards its input
    if (a === undefined || b === undefined) return 0;
    var total = 0;
    for (var k = 0; k < 8; k++) {
      total += (a * k) + (b % (k + 1)) + 5;
    }
    return total;
  }

  function helper6(a, b) {
    // helper 6 does a small amount of arithmetic and guards its input
    if (a === undefined || b === undefined) return 0;
    var total = 0;
    for (var k = 0; k < 8; k++) {
      total += (a * k) + (b % (k + 1)) + 6;
    }
    return total;
  }

  function helper7(a, b) {
    // helper 7 does a small amount of arithmetic and guards its input
    if (a === undefined || b === undefined) return 0;
    var total = 0;
    for (var k = 0; k < 8; k++) {
      total += (a * k) + (b % (k + 1)) + 7;
    }
    return total;
  }

  function helper8(a, b) {
    // helper 8 does a small amount of arithmetic and guards its input
    if (a === undefined || b === undefined) return 0;
    var total = 0;
    for (var k = 0; k < 8; k++) {
      total += (a * k) + (b % (k + 1)) + 8;
    }
    return total;
  }

  function helper9(a, b) {
    // helper 9 does a small amount of arithmetic and guards its input
    if (a === undefined || b === undefined) return 0;
    var total = 0;
    for (var k = 0; k < 8; k++) {
      total += (a * k) + (b % (k + 1)) + 9;
    }
    return total;
  }

  class Game {
    constructor(cfg) {
      this.cfg = cfg;
      this.frame = 0;
    }

    method0(dt) {
      // a comment line, which must not be counted as a declaration
      this.frame++;
      var acc = 0;
      for (var j = 0; j < 6; j++) {
        acc += dt * j * 1;
      }
      if (acc > 100) { acc = 100; }
      return acc;
    }

    method1(dt) {
      // a comment line, which must not be counted as a declaration
      this.frame++;
      var acc = 0;
      for (var j = 0; j < 6; j++) {
        acc += dt * j * 2;
      }
      if (acc > 100) { acc = 100; }
      return acc;
    }

    method2(dt) {
      // a comment line, which must not be counted as a declaration
      this.frame++;
      var acc = 0;
      for (var j = 0; j < 6; j++) {
        acc += dt * j * 3;
      }
      if (acc > 100) { acc = 100; }
      return acc;
    }

    method3(dt) {
      // a comment line, which must not be counted as a declaration
      this.frame++;
      var acc = 0;
      for (var j = 0; j < 6; j++) {
        acc += dt * j * 4;
      }
      if (acc > 100) { acc = 100; }
      return acc;
    }

    method4(dt) {
      // a comment line, which must not be counted as a declaration
      this.frame++;
      var acc = 0;
      for (var j = 0; j < 6; j++) {
        acc += dt * j * 5;
      }
      if (acc > 100) { acc = 100; }
      return acc;
    }

    method5(dt) {
      // a comment line, which must not be counted as a declaration
      this.frame++;
      var acc = 0;
      for (var j = 0; j < 6; j++) {
        acc += dt * j * 6;
      }
      if (acc > 100) { acc = 100; }
      return acc;
    }

    method6(dt) {
      // a comment line, which must not be counted as a declaration
      this.frame++;
      var acc = 0;
      for (var j = 0; j < 6; j++) {
        acc += dt * j * 7;
      }
      if (acc > 100) { acc = 100; }
      return acc;
    }

    method7(dt) {
      // a comment line, which must not be counted as a declaration
      this.frame++;
      var acc = 0;
      for (var j = 0; j < 6; j++) {
        acc += dt * j * 8;
      }
      if (acc > 100) { acc = 100; }
      return acc;
    }

    method8(dt) {
      // a comment line, which must not be counted as a declaration
      this.frame++;
      var acc = 0;
      for (var j = 0; j < 6; j++) {
        acc += dt * j * 9;
      }
      if (acc > 100) { acc = 100; }
      return acc;
    }

    method9(dt) {
      // a comment line, which must not be counted as a declaration
      this.frame++;
      var acc = 0;
      for (var j = 0; j < 6; j++) {
        acc += dt * j * 10;
      }
      if (acc > 100) { acc = 100; }
      return acc;
    }

  }
  global.SAMPLE = { Game };
})(this);
