import { MessageAction } from '../../../shared/agent/schema/AgentActionSchemas'
import { Streaming } from '../../../shared/agent/types/Streaming'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'

export const MessageActionUtil = registerActionUtil(
	class MessageActionUtil extends AgentActionUtil<MessageAction> {
		static override type = 'message' as const

		override getInfo(action: Streaming<MessageAction>) {
			return {
				description: action.text ?? '',
				canGroup: () => false,
			}
		}
	}
)
