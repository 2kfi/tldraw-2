import z from 'zod'

export const SimpleShapeIdSchema = z.string().brand('simpleShapeId')
export type SimpleShapeId = z.infer<typeof SimpleShapeIdSchema>

export type SimpleShapeIdKey = `${SimpleShapeId}_${string}`

export const TldrawShapeIdSchema = z.string().brand('tldrawShapeId')
export type TldrawShapeId = z.infer<typeof TldrawShapeIdSchema>

export function toTldrawShapeId(id: SimpleShapeId): TldrawShapeId {
	return `shape:${id}` as TldrawShapeId
}

export function toSimpleShapeId(id: string): SimpleShapeId {
	if (id.startsWith('shape:')) id = id.slice(6)
	return id as SimpleShapeId
}

export const TodoIdSchema = z.number().brand('todoId')
export type TodoId = z.infer<typeof TodoIdSchema>
