// Full receipt metadata stays on disk. Native envelopes already identify senders.
export function renderMessages(messages) {
  return messages.map(m => /^<cross-session-message\s/.test(m.content || '')
    ? m.content
    : `[agentbus from=${JSON.stringify(m.from)} name=${JSON.stringify(m.from_name)}]\n${m.content}`).join('\n\n');
}
export function startupContext(id) {
  return `agentbus coordinates agents on this machine and paired LAN hosts. use list_agents for the full roster; host_status for presence and account usage. your id: ${id}.`;
}
