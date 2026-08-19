import { Editor } from 'tldraw'

/**
 * The subset of the Agent Starter Kit's `TldrawAgent` that the action utils and
 * helpers touch. Phase 5 replaces this with the real server-side agent loop
 * (agent-loop.ts); until then the spike drives the actions against this stub.
 * ponytail: keep the stub minimal — only members referenced by the ported code.
 */
export interface AgentLike {
	editor: Editor
	chatOrigin: {
		getOrigin: () => { x: number; y: number }
	}
	schedule: (request: any) => void
	interrupt: (request: any) => void
	requests: {
		getScheduledRequest: () => any
	}
	todos: {
		push: (id: any, text: string) => void
		update: (item: any) => void
		getTodos: () => any[]
	}
}