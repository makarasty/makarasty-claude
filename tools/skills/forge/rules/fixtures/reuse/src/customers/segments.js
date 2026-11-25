export function segment(customer, orders) {
  const n = orders.filter((o) => o.customerId === customer.id).length
  return n >= 10 ? 'loyal' : n >= 2 ? 'returning' : 'new'
}
