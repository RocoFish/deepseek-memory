/**
 * Gate tests.
 *
 * The gate decides whether the plugin spends a model call after a turn, so its
 * two failure modes both matter: it must fire on real durable signals, and it
 * must stay quiet on chatter. Both directions are pinned here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describeDecision, evaluateGate } from '../src/gate.ts'

const message = (text: string) =>
  createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })

const decide = (text: string, assistantText?: string) =>
  evaluateGate({ userMessages: [message(text)], ...(assistantText === undefined ? {} : { assistantText }) })

test('an explicit request to remember always fires', () => {
  for (const text of [
    '记住我用 pnpm',
    '请记下来：部署要先跑迁移',
    '别忘了这个仓库用 ESM',
    'remember that I use pnpm',
    'make a note that the build is flaky',
    "don't forget the staging URL",
  ]) {
    const decision = decide(text)
    assert.equal(decision.run, true, `expected the gate to fire on: ${text}`)
    assert.equal(decision.signals[0]?.kind, 'explicit-remember')
  }
})

test('a correction fires, because it must override existing memory', () => {
  for (const text of [
    '不对，我用的是 npm 不是 pnpm',
    '以后不要用 emoji',
    '纠正一下，我搬到上海了',
    'actually, the config lives in the profile',
    'from now on do not add comments',
  ]) {
    assert.equal(decide(text).run, true, `expected the gate to fire on: ${text}`)
  }
})

test('a standing preference fires', () => {
  for (const text of ['我更喜欢简洁的回答', '请总是用中文回复', 'I prefer tabs over spaces']) {
    assert.equal(decide(text).run, true, `expected the gate to fire on: ${text}`)
  }
})

test('a decision or convention fires', () => {
  for (const text of ['我们决定用 tsdown 构建', 'the convention is one export per file']) {
    assert.equal(decide(text).run, true, `expected the gate to fire on: ${text}`)
  }
})

test('a constraint or gotcha fires', () => {
  for (const text of ['这个接口必须带 token', 'the catch is it only works offline']) {
    assert.equal(decide(text).run, true, `expected the gate to fire on: ${text}`)
  }
})

test('ordinary task chatter stays quiet', () => {
  for (const text of [
    '帮我看看这个函数',
    '跑一下测试',
    'ok',
    '现在几点',
    'fix the failing test in foo.ts',
    'what does this error mean?',
  ]) {
    const decision = decide(text)
    assert.equal(decision.run, false, `expected the gate to stay quiet on: ${text} (matched ${describeDecision(decision)})`)
  }
})

test('the assistant cannot create a preference, only narrate a decision', () => {
  // A model describing its own taste must not become a stored user preference.
  const preference = evaluateGate({
    userMessages: [message('继续')],
    assistantText: 'I prefer using a reducer here',
  })
  assert.equal(preference.run, false, 'assistant prose alone must not store a preference')

  // But a decision it took is a legitimate durable fact, at reduced weight.
  const decision = evaluateGate({
    userMessages: [message('继续')],
    assistantText: 'We decided to standardize on tsdown for builds.',
  })
  assert.equal(decision.run, true)
  assert.equal(decision.signals[0]?.kind, 'decision')
  assert.ok((decision.signals[0]?.weight ?? 0) < 50, 'assistant signals must weigh less than user signals')
})

test('the strongest signal wins and every match is reported', () => {
  const decision = decide('不对，记住我用的是 npm')
  assert.equal(decision.run, true)
  assert.equal(decision.signals[0]?.kind, 'explicit-remember')
  assert.ok(decision.signals.length >= 2, 'a correction alongside an explicit request should report both')
})

test('an empty turn stays quiet', () => {
  assert.equal(evaluateGate({ userMessages: [] }).run, false)
})

test('describeDecision explains both outcomes', () => {
  assert.match(describeDecision({ run: false, signals: [] }), /no durable signal/)
  assert.match(describeDecision(decide('记住这个')), /explicit-remember/)
})
