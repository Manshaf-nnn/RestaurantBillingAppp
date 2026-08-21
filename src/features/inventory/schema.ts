import { z } from 'zod'

const UNITS = ['KG', 'GRAM', 'LITRE', 'ML', 'PIECE', 'PACK', 'BOTTLE', 'DOZEN', 'BOX'] as const

export const inventoryItemSchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(1, 'Name is required').max(80),
  sku: z.string().trim().max(40).optional().or(z.literal('')),
  category: z.string().trim().max(40).optional().or(z.literal('')),
  unit: z.enum(UNITS),
  quantity: z.coerce.number().min(0).default(0),
  reorderLevel: z.coerce.number().min(0).default(0),
  costPerUnit: z.coerce.number().int().min(0).default(0),
  supplierId: z.string().cuid().optional().or(z.literal('')),
  storageArea: z.string().trim().max(40).optional().or(z.literal('')),
  expiryDate: z.string().optional().or(z.literal('')),
  /*
   * How this item is bought, when that differs from how it is counted.
   *
   * The conversion engine already handles "one box is 24 bottles" and refuses
   * rather than guessing — but it reads these two columns, and nothing in the
   * app ever wrote them. So a purchase order raised in BOX (the default the PO
   * builder takes from the supplier's pack size) threw at goods receipt with
   * "set the purchase unit", pointing at a field the owner had no way to set.
   */
  purchaseUnit: z.enum(UNITS).optional().or(z.literal('')),
  unitsPerPurchaseUnit: z.coerce.number().min(0).max(100_000).default(0),
})
export type InventoryItemInput = z.infer<typeof inventoryItemSchema>

export const stockMovementSchema = z.object({
  itemId: z.string().cuid(),
  type: z.enum(['PURCHASE', 'CONSUMPTION', 'WASTE', 'ADJUSTMENT', 'RETURN', 'EXPIRY']),
  quantity: z.coerce.number().refine((value) => value !== 0, 'Quantity cannot be zero'),
  reason: z.string().trim().max(160).optional().or(z.literal('')),
})
export type StockMovementInput = z.infer<typeof stockMovementSchema>

export const supplierSchema = z.object({
  id: z.string().cuid().optional(),
  name: z.string().trim().min(1, 'Name is required').max(80),
  contactName: z.string().trim().max(60).optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  email: z.string().email().max(255).optional().or(z.literal('')),
  address: z.string().trim().max(200).optional().or(z.literal('')),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
  isActive: z.coerce.boolean().default(true),
})
export type SupplierInput = z.infer<typeof supplierSchema>

export const purchaseSchema = z.object({
  supplierId: z.string().cuid().optional().or(z.literal('')),
  notes: z.string().trim().max(300).optional().or(z.literal('')),
  items: z
    .array(
      z.object({
        itemId: z.string().cuid(),
        quantity: z.coerce.number().positive(),
        unitCost: z.coerce.number().int().min(0),
      }),
    )
    .min(1, 'Add at least one item'),
})
export type PurchaseInput = z.infer<typeof purchaseSchema>
