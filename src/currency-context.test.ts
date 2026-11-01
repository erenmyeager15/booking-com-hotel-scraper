import test from 'node:test';
import assert from 'node:assert/strict';
import { observedCurrency } from './money.js';
test('bare symbols require compatible explicit page currency, not a requested-currency assumption',()=>{
  assert.deepEqual(observedCurrency('$180','USD'),{currency:null,status:'ambiguous'});
  assert.deepEqual(observedCurrency('$180','USD','USD'),{currency:'USD',status:'confirmed'});
  assert.deepEqual(observedCurrency('$180','USD','CAD'),{currency:'CAD',status:'mismatch'});
  assert.equal(observedCurrency('£180','USD','USD').status,'mismatch');
  assert.equal(observedCurrency('$180','GBP','GBP').status,'mismatch');
  assert.equal(observedCurrency('¥180','USD','USD').status,'mismatch');
  assert.equal(observedCurrency('¥180','JPY','JPY').status,'confirmed');
  assert.equal(observedCurrency('USD 180 / CAD 250','USD','USD').status,'ambiguous');
  assert.equal(observedCurrency('$180 £140','USD','USD').status,'mismatch');
});
