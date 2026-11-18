/** Structured adapter metadata only; message text is never an identity source. */
export function speakerIdentity(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new TypeError('invalid identity');
    const input = value;
    for (const key of ['channel', 'accountId', 'conversationId', 'speakerId']) {
        const field = input[key];
        if (typeof field !== 'string' || !field.trim() || field.length > 256 || /[\u0000-\u001f\u007f]/.test(field))
            throw new TypeError(`invalid ${key}`);
    }
    const channel = input.channel;
    const speakerId = input.speakerId;
    if (!/^[a-z][a-z0-9-]*$/.test(channel) || !speakerId.startsWith(`${channel}:`) || speakerId.length === channel.length + 1)
        throw new TypeError('invalid speakerId namespace');
    for (const key of ['speakerName', 'conversationName'])
        if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].length > 256 || /[\u0000-\u001f\u007f]/.test(input[key])))
            throw new TypeError(`invalid ${key}`);
    if (input.conversationType !== undefined && input.conversationType !== 'private' && input.conversationType !== 'group')
        throw new TypeError('invalid conversationType');
    if (input.platformMessageId !== undefined && (typeof input.platformMessageId !== 'string' || !input.platformMessageId.trim() || input.platformMessageId.length > 256 || /[\u0000-\u001f\u007f]/.test(input.platformMessageId)))
        throw new TypeError('invalid platformMessageId');
    if (input.mentionIds !== undefined && (!Array.isArray(input.mentionIds) || input.mentionIds.length > 64 || input.mentionIds.some(id => typeof id !== 'string' || !id.startsWith(`${channel}:`) || id.length <= channel.length + 1 || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id))))
        throw new TypeError('invalid mentionIds');
    return { channel, accountId: input.accountId, conversationId: input.conversationId, speakerId,
        ...(input.speakerName === undefined ? {} : { speakerName: input.speakerName }),
        ...(input.conversationType === undefined ? {} : { conversationType: input.conversationType }),
        ...(input.platformMessageId === undefined ? {} : { platformMessageId: input.platformMessageId }),
        ...(input.mentionIds === undefined ? {} : { mentionIds: [...input.mentionIds] }),
        ...(input.conversationName === undefined ? {} : { conversationName: input.conversationName }) };
}
export function conversationKey(identity) {
    // 群聊是固定的一个群，跟「哪个机器人号收到的」无关：消息里的 self_id 时有时无，
    // 带着它算 key 会开出两条群会话（2026-11-18 群里踩到：账号 0 和真号各一条，上下文、认人来回来跳）。
    if (identity.conversationType === 'group')
        return JSON.stringify([identity.channel, 'group', identity.conversationId]);
    return JSON.stringify([identity.channel, identity.accountId, identity.conversationType ?? 'private', identity.conversationId]);
}
export function identityPrefix(identity) {
    return `【消息来源 ${JSON.stringify(identity)}】\n`;
}
