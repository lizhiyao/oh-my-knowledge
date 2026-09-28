import { money } from '@task/money';

// A fixed discount reduces the taxable subtotal. Round only the final total.
export function cartTotal(items, { discount = 0, taxRate = 0 } = {}) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return money(subtotal * (1 + taxRate) - discount);
}
