import { describe, expect, it, vi } from 'vitest'

import { loadPatrolDetails, type PatrolTask, projectPatrol } from './patrol-model'

const task = (id: string, overrides: Partial<PatrolTask> = {}): PatrolTask => ({
  id,
  title: '【待上线】service｜#17已合并；测试记录',
  status: 'review',
  body: '跟踪分组：待LGTM\n还差：负责人审核最终代码\n## 问题描述\n禁止空凭据请求进入队列\n## 解决方案\n保留校验\n[实际修复 #17 CLOSED未合并](https://github.com/example/service/pull/17)\n<details><summary>历史</summary>跟踪分组：线上观察\n<details>还差：旧操作</details>\n[旧PR](https://github.com/example/service/pull/9)</details>',
  ...overrides
})

describe('current patrol projection', () => {
  it('uses native status, current sections, negative meaning and actual closed links', () => {
    const row = projectPatrol([task('a')])[0]
    expect(row.issue).toBe('禁止空凭据请求进入队列')
    expect(row.status).toBe('待审核')
    expect(row.gate).toBe('负责人审核最终代码')
    expect(row.refs).toEqual([
      {
        url: 'https://github.com/example/service/pull/17',
        repo: 'example/service',
        number: '17',
        state: '已关闭（未合并）'
      }
    ])
    expect(projectPatrol([task('a', { status: 'done' })])[0].status).toBe('已完成')
    expect(projectPatrol([task('a', { status: 'todo' })])[0].status).toBe('待处理')
    expect(projectPatrol([task('a', { status: 'blocked' })])[0].status).toBe('受阻')
    expect(projectPatrol([task('a', { status: 'scheduled', title: '', body: '' })])[0].status).toBe('待确认')
  })

  it('coalesces only matching complete current problems, refs and gates while retaining every id', () => {
    const original = task('a')

    const rows = projectPatrol([
      original,
      task('b'),
      task('c', { body: original.body?.replace('禁止空凭据请求进入队列', '禁止重复请求') }),
      task('d', { body: original.body?.replace('example/service/pull/17', 'other/service/pull/17') }),
      task('e', { body: original.body?.replace('负责人审核最终代码', '原构建器提供打包结果') }),
      task('helper', { title: '汇总报告', body: '目标：汇总检查结果 #17' })
    ])

    expect(rows).toHaveLength(5)
    expect(rows[0].ids).toEqual(['a', 'b'])
    expect(rows.flatMap(row => row.ids).sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'helper'])
    expect(rows[0].search).toContain('b')
  })

  it('does not manufacture summaries, next steps or PR links; bounds hostile markup as plain text', () => {
    const row = projectPatrol([
      task('a', { body: '', title: '【待上线】service｜#17已合并；测试记录', status: 'todo' })
    ])[0]

    expect(row.issue).toBe('待补充问题摘要')
    expect(row.gate).toBe('待补充下一步')
    expect(row.refs).toEqual([])

    const hostile = projectPatrol([
      task('x', {
        body: '看板问题：未允许<img src=x onerror=alert(1)>重复请求\n还差：不要部署<script>alert(1)</script>\n[PR](javascript:alert(1))'
      })
    ])[0]

    expect(hostile.issue).toBe('未允许重复请求')
    expect(hostile.gate).toBe('不要部署')
    expect(hostile.refs).toEqual([])
  })
})

it('maps waiting stages honestly and extracts current gates before using status fallbacks', () => {
  const cases = [
    ['scheduled', '线上观察', '观察中'],
    ['scheduled', '待上线', '待上线'],
    ['scheduled', '待验证', '待确认'],
    ['review', '待验证', '待确认'],
    ['running', '待上线', '处理中'],
    ['ready', '线上观察', '待处理']
  ]

  for (const [status, stage, expected] of cases) {
    expect(projectPatrol([task('a', { status, body: `跟踪分组：${stage}` })])[0].status).toBe(expected)
  }

  expect(
    projectPatrol([
      task('a', { status: 'todo', body: '代码状态：当前头assemble仍无成功日志；原构建器尚未提供打包结果' })
    ])[0].gate
  ).toBe('原构建器提供当前头打包结果')
  expect(projectPatrol([task('a', { body: '线上状态：生产纳入待确认' })])[0].gate).toBe('确认生产版本包含修复')
  expect(projectPatrol([task('a', { body: '还差：禁止部署，先确认版本' })])[0].gate).toBe('禁止部署，先确认版本')
})

it('does not infer merge approval or closure from negated or unknown PR labels', () => {
  const reference = (label: string) =>
    projectPatrol([task('a', { body: `[${label}](https://github.com/example/service/pull/17)` })])[0].refs[0].state

  expect(reference('OPEN 未合并')).toBe('开放中')
  expect(reference('CLOSED')).toBe('已关闭')
  expect(reference('CLOSED 已合并')).toBe('已合并')
  expect(reference('UNMERGED')).toBe('状态待确认')
  expect(reference('NOT MERGED; NOT OPEN')).toBe('状态待确认')
})

const linkedCards: PatrolTask[] = [
  {
    id: 'business',
    title: 'service｜空请求失效',
    status: 'blocked',
    link_counts: { parents: 3, children: 0 },
    body: '**PR：** [修复 OPEN](https://github.com/example/service/pull/31)\n看板问题：空请求绕过校验\n还差：提供打包及审核结果'
  },
  ...['测试', '打包', '汇总'].map((step, index) => ({
    id: `helper-${index}`,
    title: `${step} #31 证据`,
    body: `目标：为 PR #31 提供${step}证据`,
    status: 'todo',
    link_counts: { parents: 0, children: 1 }
  }))
]

const linkedDetails = Object.fromEntries(
  linkedCards.map(card => [
    card.id,
    {
      task: card,
      links:
        card.id === 'business'
          ? { parents: linkedCards.slice(1).map(card => card.id), children: [] }
          : { parents: [], children: ['business'] }
    }
  ])
)

it('groups only a complete explicit dependency goal, preserving helper search and distinct business bugs', () => {
  const grouped = projectPatrol(linkedCards, linkedDetails)
  expect(grouped).toHaveLength(1)
  expect(grouped[0].ids[0]).toBe('business')
  expect([...grouped[0].ids].sort()).toEqual(linkedCards.map(card => card.id).sort())
  expect(grouped[0].search).toContain('汇总')
  expect(grouped[0].members).toHaveLength(4)
  expect(
    projectPatrol(linkedCards, Object.fromEntries(Object.entries(linkedDetails).filter(([id]) => id !== 'helper-0')))
  ).toHaveLength(4)

  const changed = linkedCards.map(card =>
    card.id === 'helper-0' ? { ...card, body: card.body + '\n看板问题：另一个业务缺陷' } : card
  )

  expect(projectPatrol(changed, linkedDetails)).toHaveLength(4)

  const crossRepo = linkedCards.map(card =>
    card.id === 'helper-0' ? { ...card, body: card.body + '\n[PR](https://github.com/other/service/pull/31)' } : card
  )

  expect(projectPatrol(crossRepo, linkedDetails)).toHaveLength(4)
})

it('takes only current PR preamble and canonicalizes comment links while keeping a closed primary', () => {
  const row = projectPatrol([
    task('a', {
      body: '**PR：** [实际提案 CLOSED未合并](https://github.com/example/service/pull/31#issuecomment-5) · [同一提案](https://github.com/example/service/pull/31) · [已替代测试](https://github.com/example/service/pull/30)\n## 验证结果\n[证据](https://github.com/example/service/pull/29)'
    })
  ])[0]

  expect(row.refs).toEqual([
    {
      repo: 'example/service',
      number: '31',
      url: 'https://github.com/example/service/pull/31',
      state: '已关闭（未合并）'
    }
  ])
})

it('extracts concrete current blockers without session protocols or historical gates', () => {
  const row = projectPatrol([
    task('a', {
      status: 'blocked',
      body: '<details>还差：旧操作</details>',
      latest_summary: '等待运维恢复失效会话并确认退款匹配结果；修复已合并。'
    })
  ])[0]

  expect(row.gate).toBe('等待运维恢复失效会话并确认退款匹配结果')
  expect(
    projectPatrol([
      task('a', {
        body: '',
        latest_summary: '会话 abcdef01-1234-1234-1234-abcdefabcdef list_turns 失败；需恢复原会话。'
      })
    ])[0].gate
  ).toBe('恢复原执行会话')
})

it('bounds linked reads and leaves missing records independent after failures or timeout', async () => {
  vi.useFakeTimers()

  try {
    const result = loadPatrolDetails(linkedCards, async id =>
      id === 'helper-0' ? new Promise<never>(() => {}) : linkedDetails[id]
    )

    await vi.advanceTimersByTimeAsync(8001)
    const loaded = await result
    expect(loaded.unavailable).toBe(true)
    expect(projectPatrol(linkedCards, loaded.details).flatMap(row => row.ids)).toHaveLength(4)
  } finally {
    vi.useRealTimers()
  }
})

it('preserves negation in current waiting text and retains a sole closed current proposal', () => {
  const row = projectPatrol([
    task('a', { status: 'blocked', body: '', latest_summary: '无需等待上游；等待运行方提供验证输入。' })
  ])[0]

  expect(row.gate).toBe('等待运行方提供验证输入')
  expect(
    projectPatrol([
      task('a', { body: '**PR：** [测试刻画 CLOSED未合并](https://github.com/example/service/pull/31)' })
    ])[0].refs[0].state
  ).toBe('已关闭（未合并）')
})
