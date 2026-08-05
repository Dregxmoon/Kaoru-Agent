const { add, subtract, oldName } = require('./calc');

test('add', () => {
  if (add(1, 2) !== 3) throw new Error('add falla');
});
test('subtract', () => {
  if (subtract(5, 3) !== 2) throw new Error('subtract falla');
});
test('oldName', () => {
  if (oldName(3, 4) !== 12) throw new Error('oldName falla');
});
