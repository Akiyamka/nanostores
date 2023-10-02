import { delay } from 'nanodelay'
import { test } from 'uvu'
import { equal, is, throws } from 'uvu/assert'

import {
  action,
  allTasks,
  applySerializedContext,
  atom,
  computed,
  createContext,
  keepMount,
  lastAction,
  onAction,
  onMount,
  onNotify,
  onSet,
  onStart,
  onStop,
  resetContext,
  serializeContext,
  startTask,
  task,
  withContext
} from '../index.js'

test.after(() => {
  resetContext()
})

// Helper function for debugging the origin of a context
function namedCtx(name: string): any {
  let ctx = createContext()
  ;(ctx as any).id = name
  return ctx
}

test('creating a context pollutes the global context', () => {
  let $counter = atom(0)

  equal($counter.get(), 0)
  equal($counter.value, 0)

  $counter.set(321)
  equal($counter.get(), 321)
  equal($counter.value, 321)

  let ctx1 = createContext()
  throws($counter.get)
  throws(() => $counter.value)

  equal(withContext($counter, ctx1).value, 0)
})

test(`cloned atom's functions retain clone's context`, () => {
  let $counter = atom(0)

  let ctx1 = createContext()
  let $counterCtx = withContext($counter, ctx1)

  // Destructure to, theoretically, lose context completely
  let { get, listen, set, subscribe } = $counterCtx

  set(123)
  equal(get(), 123)

  let events: number[] = []
  listen(v => events.push(v))
  subscribe(v => events.push(v))
  // @ts-expect-error: notify exists there
  $counterCtx.notify()

  equal(events, [123, 123, 123])
})

test('change to context takes effect', () => {
  let $counter = atom(0)

  let ctx1 = createContext()
  let ctx2 = createContext()

  withContext($counter, ctx1).set(2)
  withContext($counter, ctx2).set(4)

  throws($counter.get)

  equal(withContext($counter, ctx1).value, 2)
  equal(withContext($counter, ctx2).value, 4)

  resetContext(ctx1)

  equal(withContext($counter, ctx1), withContext($counter, ctx1))
})

test('basic `onStart` lifecycling', () => {
  let $counter = atom(0)

  let events: (number | undefined)[] = []
  let startCalls = 0
  onStart($counter, ({ ctx }) => {
    startCalls++
    events.push(ctx($counter).value)
  })

  let ctx1 = createContext()
  let ctx2 = createContext()

  let $counter1 = withContext($counter, ctx1)
  let $counter2 = withContext($counter, ctx2)
  $counter1.set(2)
  $counter2.set(4)

  keepMount($counter1)
  equal(startCalls, 1)

  keepMount($counter2)
  equal(startCalls, 2)

  equal(events, [2, 4])
})

test('basic `onSet` lifecycling', () => {
  let $counter = atom(0)

  let events: (number | undefined)[] = []
  let setCalls = 0
  onSet($counter, ({ newValue }) => {
    setCalls++
    events.push(newValue)
  })

  let ctx1 = createContext()
  let ctx2 = createContext()

  let $counter1 = withContext($counter, ctx1)
  let $counter2 = withContext($counter, ctx2)
  $counter1.set(2)
  equal(setCalls, 1)
  equal(events, [2])

  $counter2.set(4)
  equal(setCalls, 2)
  equal(events, [2, 4])
})

test('basic `computed` work', () => {
  let $one = atom(0)
  let $two = atom(0)

  let $cmp = computed([$one, $two], (one, two) => one + two)

  let ctx1 = createContext()
  let ctx2 = createContext()

  let events: number[] = []
  withContext($cmp, ctx1).subscribe(v => events.push(v))
  withContext($one, ctx1).set(5)
  withContext($two, ctx1).set(5)

  withContext($one, ctx2).set(10)
  withContext($two, ctx2).set(10)

  equal(events, [0, 5, 10])
  equal(withContext($cmp, ctx2).get(), 20)
})

test('basic `task` work', async () => {
  let ctx1 = createContext()
  let ctx2 = createContext()

  let track = ''

  async function taskA(): Promise<void> {
    let end = startTask(ctx1)
    setTimeout(() => {
      taskB()
      track += 'a'
      end()
    }, 100)
  }

  async function taskB(): Promise<void> {
    let result = await task(async () => {
      await Promise.resolve()
      track += 'b'
      return 5
    }, ctx1)
    equal(result, 5)
  }

  taskA()

  await allTasks(ctx2)
  equal(track, '')
  await allTasks(ctx1)
  equal(track, 'ab')
})

test('basic `action` work', async () => {
  let events: (string | undefined)[] = []
  let $atom = atom(0)

  let ctx1 = namedCtx('ctx1')
  let ctx2 = namedCtx('ctx2')

  onNotify($atom, ({ ctx }) => {
    let $withCtx = ctx($atom)
    events.push(($withCtx as any).ctx.id, $withCtx[lastAction])
  })

  let setProp = action($atom, 'setProp', (s, num: number) => {
    s.set(num)
  })

  setProp(1, ctx1)
  setProp(2, ctx2)
  equal(withContext($atom, ctx1).get(), 1)
  equal(withContext($atom, ctx2).get(), 2)

  equal(events, ['ctx1', 'setProp', 'ctx2', 'setProp'])
})

test('action works with `withContext`', async () => {
  let events: (string | undefined)[] = []
  let $atom = atom(0)

  let ctx1 = namedCtx('ctx1')
  let ctx2 = namedCtx('ctx2')

  onNotify($atom, ({ ctx }) => {
    let $withCtx = ctx($atom)
    events.push(($withCtx as any).ctx.id, $withCtx[lastAction])
  })

  let setProp = action($atom, 'setProp', (s, num: number) => {
    s.set(num)
  })

  // Retains identity between calls
  is(withContext(setProp, ctx1), withContext(setProp, ctx1))

  withContext(setProp, ctx1)(1)
  withContext(setProp, ctx2)(2)

  equal(withContext($atom, ctx1).get(), 1)
  equal(withContext($atom, ctx2).get(), 2)

  equal(events, ['ctx1', 'setProp', 'ctx2', 'setProp'])
})

test('all lifecycles accept `ctx`', async () => {
  let $atom = atom(0)

  let ctx1 = namedCtx('ctx1')
  let ctx2 = namedCtx('ctx2')

  let events: string[] = []
  let push =
    (type: string) =>
    ({ ctx }: any) => {
      events.push(`${type}_${ctx($atom).ctx.id}`)
    }
  onNotify($atom, push('notify'))
  onNotify($atom, push('notify'))
  onSet($atom, push('set'))
  onSet($atom, push('set'))
  onStart($atom, push('start'))
  onStart($atom, push('start'))
  onStop($atom, push('stop'))
  onMount($atom, push('mount'))
  onStop($atom, push('stop'))
  onMount($atom, push('mount'))
  onMount($atom, push('mount'))
  onStop($atom, push('stop'))
  onAction($atom, push('action'))
  onAction($atom, push('action'))

  let changeValue = action($atom, 'change', ($store, value: number) => {
    $store.set(value)
  })

  let $atom1 = withContext($atom, ctx1)
  let $atom2 = withContext($atom, ctx2)

  let unbind1 = $atom1.listen(() => {})
  let unbind2 = $atom2.listen(() => {})

  changeValue(1, ctx1)
  changeValue(2, ctx2)

  unbind1()
  unbind2()

  equal(events, [
    'mount_ctx1',
    'mount_ctx1',
    'mount_ctx1',
    'start_ctx1',
    'start_ctx1',
    'mount_ctx2',
    'mount_ctx2',
    'mount_ctx2',
    'start_ctx2',
    'start_ctx2',
    'action_ctx1',
    'action_ctx1',
    'set_ctx1',
    'set_ctx1',
    'notify_ctx1',
    'notify_ctx1',
    'action_ctx2',
    'action_ctx2',
    'set_ctx2',
    'set_ctx2',
    'notify_ctx2',
    'notify_ctx2',
    'stop_ctx1',
    'stop_ctx1',
    'stop_ctx1',
    'stop_ctx2',
    'stop_ctx2',
    'stop_ctx2'
  ])
})

test('test the whole serialization flow', async () => {
  let $serializedAtom = atom(0)
  $serializedAtom.name = 'serialized'

  let $notSerializedAtom = atom(0)

  let randomValues = new Map()

  let updateAction = async (ms: number, ctx: unknown): Promise<void> => {
    let endTask = startTask(ctx)

    await delay(ms)
    let random = Math.random()
    randomValues.set(ctx, random)
    withContext($serializedAtom, ctx).set(random)
    withContext($notSerializedAtom, ctx).set(random)

    endTask()
  }

  let ctx1 = createContext()
  let ctx2 = createContext()

  updateAction(50, ctx1)
  updateAction(10, ctx2)

  await allTasks(ctx1)
  let serializedCtx1 = serializeContext(ctx1)
  let ctx1GenNumber = randomValues.get(ctx1)

  let serializedCtx2 = serializeContext(ctx2)
  let ctx2GenNumber = randomValues.get(ctx2)

  resetContext()

  ctx1 = createContext()
  applySerializedContext(ctx1, serializedCtx1)
  ctx2 = createContext()
  applySerializedContext(ctx2, serializedCtx2)

  equal(withContext($serializedAtom, ctx1).get(), ctx1GenNumber)
  equal(withContext($notSerializedAtom, ctx1).get(), 0)
  equal(withContext($serializedAtom, ctx2).get(), ctx2GenNumber)
})

test.run()
