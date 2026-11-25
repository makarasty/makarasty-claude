import { cents2str, totalOf } from '../shared/fmt.js'
import { shortDay } from '../shared/when.js'
import { need } from '../shared/check.js'

export function orderLine(order) {
  need(order, ['id', 'createdAt', 'items'])
  return `Order ${order.id} (${shortDay(order.createdAt)}): ${cents2str(totalOf(order.items))}`
}
