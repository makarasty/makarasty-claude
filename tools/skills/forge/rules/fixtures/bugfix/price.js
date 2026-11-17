// Order total in cents.
export const total = (items) => items.reduce((sum, item) => sum + item.price, 0)
