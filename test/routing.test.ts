import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGroupList, routeMessage, RouteInput } from '../src/handlers/routing';
import { webhookUrl } from '../src/agent/forwarder';

const COMPLIANCE = '120363411324724934@g.us';
const OTHER = '120363408817351484@g.us';

function input(overrides: Partial<RouteInput>): RouteInput {
  return {
    groupJid: OTHER,
    addressedToBot: false,
    agentGroups: [COMPLIANCE],
    agentConfigured: true,
    aiEnabled: true,
    ...overrides
  };
}

test('a reply to the bot in a pm-agent group goes to pm-agent, not the AI', () => {
  assert.equal(routeMessage(input({ groupJid: COMPLIANCE, addressedToBot: true })), 'forward');
});

test('a plain message in a pm-agent group still goes to pm-agent', () => {
  assert.equal(routeMessage(input({ groupJid: COMPLIANCE, addressedToBot: false })), 'forward');
});

test('the AI never replies in a pm-agent group, even when pm-agent is not set up', () => {
  assert.equal(
    routeMessage(input({ groupJid: COMPLIANCE, addressedToBot: true, agentConfigured: false })),
    'skip'
  );
});

test('other groups keep the AI reply when the bot is tagged', () => {
  assert.equal(routeMessage(input({ addressedToBot: true })), 'ai');
});

test('other groups ignore messages that do not address the bot', () => {
  assert.equal(routeMessage(input({ addressedToBot: false })), 'skip');
});

test('with the AI turned off, a tag in another group goes to pm-agent', () => {
  assert.equal(routeMessage(input({ addressedToBot: true, aiEnabled: false })), 'forward');
  assert.equal(
    routeMessage(input({ addressedToBot: true, aiEnabled: false, agentConfigured: false })),
    'skip'
  );
});

test('the group list is comma separated and ignores blanks', () => {
  assert.deepEqual(parseGroupList(` ${COMPLIANCE} , ,${OTHER}`), [COMPLIANCE, OTHER]);
  assert.deepEqual(parseGroupList(undefined), []);
});

test('the webhook URL works with or without /webhook on the end', () => {
  assert.equal(webhookUrl('https://pm-agent.example.com'), 'https://pm-agent.example.com/webhook');
  assert.equal(webhookUrl('https://pm-agent.example.com/'), 'https://pm-agent.example.com/webhook');
  assert.equal(webhookUrl('https://pm-agent.example.com/webhook'), 'https://pm-agent.example.com/webhook');
});
