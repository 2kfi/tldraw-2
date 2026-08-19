import { AI_STATE_ID } from '../../shared/schema'
import type { AiState } from '../../shared/schema'

/**
 * A 'running' aiState is only valid while the session loop is actively streaming
 * into it. Anything else (server restart, crashed loop, stale lock) must be reset
 * to idle and unlocked, otherwise the room is stuck pending forever.
 */
export function resetStaleAiState(aiState: AiState): AiState {
	if (aiState.status !== 'running') return aiState
	return {
		...aiState,
		status: 'idle',
		lockedBy: null,
		lockedByName: null,
		streamingText: '',
		error: null,
	}
}