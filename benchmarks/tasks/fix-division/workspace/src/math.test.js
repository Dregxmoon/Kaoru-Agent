const { test } = require('node:test');
const { add, subtract, divide } = require('./math');

test('add', () => {
  if (add(1, 2) !== 3) throw new Error('add falla');
});
test('subtract', () => {
  if (subtract(5, 3) !== 2) throw new Error('subtract falla');
});
test('divide', () => {
  if (divide(10, 2) !== 5) throw new Error('divide falla');
});
