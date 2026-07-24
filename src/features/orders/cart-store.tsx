'use client'

import * as React from 'react'

import type { PublicMenuItem } from '@/features/menu/queries'

/**
 * Guest cart.
 *
 * Lives entirely in the browser (localStorage) so a guest can browse, refresh
 * and even lose signal without losing their basket. Prices held here are for
 * display only — the server re-prices every line from the database at checkout.
 */

export interface CartOption {
  groupId: string
  groupName: string
  optionId: string
  name: string
  priceDelta: number
}

export interface CartLine {
  /** Stable key: same food + same options collapse into one line. */
  key: string
  foodId: string
  name: string
  imageUrl: string | null
  unitPrice: number
  quantity: number
  options: CartOption[]
  notes: string
  isVeg: boolean
  prepTimeMinutes: number
}

export interface TableSession {
  tableId: string
  tableNumber: string
  label: string | null
}

interface CartState {
  lines: CartLine[]
  table: TableSession | null
  couponCode: string
  customer: { name: string; phone: string; email: string }
}

const EMPTY: CartState = {
  lines: [],
  table: null,
  couponCode: '',
  customer: { name: '', phone: '', email: '' },
}

const STORAGE_PREFIX = 'ros.cart'

function storageKey(restaurantId: string) {
  return `${STORAGE_PREFIX}.${restaurantId}`
}

function lineKey(foodId: string, options: CartOption[], notes: string) {
  const optionPart = options
    .map((option) => option.optionId)
    .sort()
    .join('|')
  return `${foodId}::${optionPart}::${notes.trim().toLowerCase()}`
}

type Action =
  | { type: 'hydrate'; state: CartState }
  | { type: 'add'; line: Omit<CartLine, 'key'> }
  | { type: 'setQuantity'; key: string; quantity: number }
  | { type: 'remove'; key: string }
  | { type: 'setNotes'; key: string; notes: string }
  | { type: 'setTable'; table: TableSession | null }
  | { type: 'setCoupon'; code: string }
  | { type: 'setCustomer'; customer: Partial<CartState['customer']> }
  | { type: 'clearLines' }
  | { type: 'reset' }

function reducer(state: CartState, action: Action): CartState {
  switch (action.type) {
    case 'hydrate':
      return action.state

    case 'add': {
      const key = lineKey(action.line.foodId, action.line.options, action.line.notes)
      const existing = state.lines.find((line) => line.key === key)
      if (existing) {
        return {
          ...state,
          lines: state.lines.map((line) =>
            line.key === key
              ? { ...line, quantity: Math.min(50, line.quantity + action.line.quantity) }
              : line,
          ),
        }
      }
      return { ...state, lines: [...state.lines, { ...action.line, key }] }
    }

    case 'setQuantity': {
      if (action.quantity <= 0) {
        return { ...state, lines: state.lines.filter((line) => line.key !== action.key) }
      }
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.key === action.key ? { ...line, quantity: Math.min(50, action.quantity) } : line,
        ),
      }
    }

    case 'remove':
      return { ...state, lines: state.lines.filter((line) => line.key !== action.key) }

    case 'setNotes':
      return {
        ...state,
        lines: state.lines.map((line) =>
          line.key === action.key ? { ...line, notes: action.notes } : line,
        ),
      }

    case 'setTable':
      return { ...state, table: action.table }

    case 'setCoupon':
      return { ...state, couponCode: action.code }

    case 'setCustomer':
      return { ...state, customer: { ...state.customer, ...action.customer } }

    case 'clearLines':
      return { ...state, lines: [], couponCode: '' }

    case 'reset':
      return EMPTY

    default:
      return state
  }
}

interface CartContextValue {
  state: CartState
  hydrated: boolean
  itemCount: number
  subtotal: number
  addItem: (item: PublicMenuItem, options: CartOption[], quantity: number, notes: string) => void
  setQuantity: (key: string, quantity: number) => void
  removeLine: (key: string) => void
  setLineNotes: (key: string, notes: string) => void
  setTable: (table: TableSession | null) => void
  setCoupon: (code: string) => void
  setCustomer: (customer: Partial<CartState['customer']>) => void
  clearLines: () => void
  reset: () => void
}

const CartContext = React.createContext<CartContextValue | null>(null)

export function CartProvider({
  restaurantId,
  children,
}: {
  restaurantId: string
  children: React.ReactNode
}) {
  const [state, dispatch] = React.useReducer(reducer, EMPTY)
  const [hydrated, setHydrated] = React.useState(false)

  // Restore on mount.
  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey(restaurantId))
      if (raw) {
        const parsed = JSON.parse(raw) as CartState
        if (parsed && Array.isArray(parsed.lines)) {
          dispatch({ type: 'hydrate', state: { ...EMPTY, ...parsed } })
        }
      }
    } catch {
      // Corrupt or unavailable storage — start clean rather than crash.
    }
    setHydrated(true)
  }, [restaurantId])

  // Persist on change.
  React.useEffect(() => {
    if (!hydrated) return
    try {
      window.localStorage.setItem(storageKey(restaurantId), JSON.stringify(state))
    } catch {
      /* quota exceeded / private mode — the cart still works in memory */
    }
  }, [state, hydrated, restaurantId])

  const value = React.useMemo<CartContextValue>(() => {
    const itemCount = state.lines.reduce((total, line) => total + line.quantity, 0)
    const subtotal = state.lines.reduce(
      (total, line) =>
        total +
        (line.unitPrice + line.options.reduce((sum, option) => sum + option.priceDelta, 0)) *
          line.quantity,
      0,
    )

    return {
      state,
      hydrated,
      itemCount,
      subtotal,
      addItem: (item, options, quantity, notes) =>
        dispatch({
          type: 'add',
          line: {
            foodId: item.id,
            name: item.name,
            imageUrl: item.imageUrl,
            unitPrice: item.price,
            quantity,
            options,
            notes,
            isVeg: item.isVeg,
            prepTimeMinutes: item.prepTimeMinutes,
          },
        }),
      setQuantity: (key, quantity) => dispatch({ type: 'setQuantity', key, quantity }),
      removeLine: (key) => dispatch({ type: 'remove', key }),
      setLineNotes: (key, notes) => dispatch({ type: 'setNotes', key, notes }),
      setTable: (table) => dispatch({ type: 'setTable', table }),
      setCoupon: (code) => dispatch({ type: 'setCoupon', code }),
      setCustomer: (customer) => dispatch({ type: 'setCustomer', customer }),
      clearLines: () => dispatch({ type: 'clearLines' }),
      reset: () => dispatch({ type: 'reset' }),
    }
  }, [state, hydrated])

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>
}

export function useCart(): CartContextValue {
  const context = React.useContext(CartContext)
  if (!context) throw new Error('useCart must be used inside a CartProvider')
  return context
}

export function lineTotal(line: CartLine): number {
  return (
    (line.unitPrice + line.options.reduce((sum, option) => sum + option.priceDelta, 0)) *
    line.quantity
  )
}
