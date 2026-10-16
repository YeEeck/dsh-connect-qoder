/**
 * 对话框用量胶囊的 DOM 行为，跑 SHIPPED 的 `lib/client.js`。
 *
 * Run: node --test test/composer-pill-dom.test.js
 *
 * 为什么另开一个文件：`composer-pill.test.js` 是纯模型层 + 静态断言（能 `node --test`
 * 直接跑），但「用户真的在输入框旁边看到 `Qoder CN · 1,034`、点开面板、Esc 能关」
 * 只能靠 `test/helpers/render-card.js` 把 `lib/client.js` 在 jsdom 里渲出来才证明。
 * 走同一个产物，CI 已 build 过，本文件不另建 bundling 假设。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCardBundle, renderCards } from './helpers/render-card.js'

/** 一个应答 host 路由的 fetch 桩。 */
function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body }
}

const USAGE_BODY = {
  regions: [
    {
      region: 'qoder-cn',
      regionName: 'Qoder CN',
      available: true,
      userQuota: { used: 266, total: 1300, remaining: 1034, unit: 'credits', percentage: 0.2046 },
      addOnQuota: { used: 0, total: 100, remaining: 100, unit: 'credits', percentage: 0 },
      checkin: { active: true, todayCheckedIn: false, amount: 100 },
    },
  ],
}

const fetchStub = async (url) => {
  const path = String(url)
  if (path.includes('/plugins/dsh-connect-qoder/usage')) return jsonResponse(USAGE_BODY)
  return jsonResponse({})
}

/** 找出 apply() 注册到 `conversation.input.right` 的那条座席。 */
function composerSlotOf(slots) {
  return slots.find((entry) => entry.slot?.name === 'conversation.input.right')
}

test('the shipped bundle registers the composer pill slot', async () => {
  const { slots } = await loadCardBundle({ fetchImpl: fetchStub })
  const slot = composerSlotOf(slots)
  assert.ok(slot, 'expected a conversation.input.right registration in lib/client.js')
  assert.equal(slot.slot.id, 'llm-qoder-composer-pill')
  assert.equal(typeof slot.card, 'function')
})

test('renders the region prefix and the primary remaining credits', async () => {
  const { slots, window: w, registered, scope } = await loadCardBundle({ fetchImpl: fetchStub })
  const card = composerSlotOf(slots)
  const { container, unmount } = await renderCards({
    card,
    registered,
    scope,
    window: w,
    props: { useProjection: () => ({ next: { provider: 'qoder-cn' } }) },
  })
  try {
    const text = container.textContent ?? ''
    assert.match(text, /Qoder CN/)
    assert.match(text, /1,034/)
    assert.ok(!/—/.test(text), 'expected a real reading, not the unknown dash')
  } finally {
    unmount()
  }
})

test('opens the panel on click and shows the raw quota detail', async () => {
  const { slots, window: w, registered, scope } = await loadCardBundle({ fetchImpl: fetchStub })
  const card = composerSlotOf(slots)
  const { container, unmount, react } = await renderCards({
    card,
    registered,
    scope,
    window: w,
    props: { useProjection: () => ({ next: { provider: 'qoder-cn' } }) },
  })
  try {
    const button = container.querySelector('button')
    assert.ok(button, 'expected a toggle button')
    assert.equal(button.getAttribute('aria-expanded'), 'false')
    await react.act(async () => {
      button.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(button.getAttribute('aria-expanded'), 'true')
    const panel = container.querySelector('[role="dialog"]')
    assert.ok(panel, 'expected a popover dialog after opening')
    const text = panel.textContent ?? ''
    assert.match(text, /1,034/)
    assert.match(text, /100/)
    assert.match(text, /签到领/)
  } finally {
    unmount()
  }
})

test('Escape closes the panel', async () => {
  const { slots, window: w, registered, scope } = await loadCardBundle({ fetchImpl: fetchStub })
  const card = composerSlotOf(slots)
  const { container, unmount, react } = await renderCards({
    card,
    registered,
    scope,
    window: w,
    props: { useProjection: () => ({ next: { provider: 'qoder-cn' } }) },
  })
  try {
    const button = container.querySelector('button')
    await react.act(async () => {
      button.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))
    })
    assert.ok(container.querySelector('[role="dialog"]'))
    await react.act(async () => {
      w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(container.querySelector('[role="dialog"]'), null)
  } finally {
    unmount()
  }
})

test('a non-Qoder provider renders nothing', async () => {
  const { slots, window: w, registered, scope } = await loadCardBundle({ fetchImpl: fetchStub })
  const card = composerSlotOf(slots)
  const { container, unmount } = await renderCards({
    card,
    registered,
    scope,
    window: w,
    props: { useProjection: () => ({ next: { provider: 'deepseek' } }) },
  })
  try {
    const text = container.textContent ?? ''
    assert.ok(!/Qoder/.test(text), 'a non-Qoder provider must not render the pill')
    assert.equal(container.querySelector('[role="dialog"]'), null)
  } finally {
    unmount()
  }
})

test('a missing region shows the dash, never a fabricated zero', async () => {
  // 桩里不含当前 region：读不到时胶囊必须显示 `—`（"还没查到"），不能写 0
  // （"你额度用完了"）。这是红线 1 的读数侧：把缺数据说成事实就是撒谎。
  const emptyStub = async (url) => {
    const path = String(url)
    if (path.includes('/plugins/dsh-connect-qoder/usage')) return jsonResponse({ regions: [] })
    return jsonResponse({})
  }
  const { slots, window: w, registered, scope } = await loadCardBundle({ fetchImpl: emptyStub })
  const card = composerSlotOf(slots)
  const { container, unmount } = await renderCards({
    card,
    registered,
    scope,
    window: w,
    props: { useProjection: () => ({ next: { provider: 'qoder-cn' } }) },
  })
  try {
    assert.match(container.textContent ?? '', /Qoder CN\s*·\s*—/)
    assert.ok(!/0\s*$/.test((container.textContent ?? '').trim()))
  } finally {
    unmount()
  }
})

test('the panel claims today\'s check-in and reflects it after the re-read', async () => {
  // 有状态的桩：第一次读 todayCheckedIn=false，POST /checkin 后置 true，下一次
  // GET /usage 返回已签到——复现「领取 → 重读 → 余额与状态一起更新」的真实链路。
  const calls = []
  let checkedIn = false
  const usageOf = () => ({
    regions: [
      {
        region: 'qoder-cn',
        available: true,
        userQuota: { used: 266, total: 1300, remaining: 1034, unit: 'credits', percentage: 0.2046 },
        addOnQuota: { used: 0, total: 100, remaining: 100, unit: 'credits', percentage: 0 },
        checkin: { active: true, todayCheckedIn: checkedIn, amount: 100 },
      },
    ],
  })
  const stub = async (url, options) => {
    const path = String(url)
    if (path.includes('/plugins/dsh-connect-qoder/checkin')) {
      calls.push({ path, method: options?.method ?? 'GET' })
      checkedIn = true
      return jsonResponse({ amount: 100 })
    }
    if (path.includes('/plugins/dsh-connect-qoder/usage')) return jsonResponse(usageOf())
    return jsonResponse({})
  }
  const { slots, window: w, registered, scope } = await loadCardBundle({ fetchImpl: stub })
  const card = composerSlotOf(slots)
  const { container, unmount, react } = await renderCards({
    card,
    registered,
    scope,
    window: w,
    props: { useProjection: () => ({ next: { provider: 'qoder-cn' } }) },
  })
  try {
    const toggle = container.querySelector('button')
    await react.act(async () => {
      toggle.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))
    })
    const panel = container.querySelector('[role="dialog"]')
    assert.ok(panel, 'expected the popover')
    const claimButton = [...panel.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('签到领'))
    assert.ok(claimButton, 'expected a check-in claim button in the popover')
    assert.ok((claimButton.textContent ?? '').includes('100'))

    await react.act(async () => {
      claimButton.dispatchEvent(new w.MouseEvent('click', { bubbles: true }))
    })
    // 领取后组件会重读 usage；多让几条微任务落定。
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    assert.ok(calls.length >= 1, 'expected the check-in route to be called')
    assert.match(calls[0].path, /region=qoder-cn/)
    assert.match((panel.textContent ?? '') + (container.textContent ?? ''), /今日已签到/)
  } finally {
    unmount()
  }
})