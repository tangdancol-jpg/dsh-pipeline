/**
 * 四槽②「模式」的**预校验** —— 会话头 `agentPreset` 到底有哪些合法取值。
 *
 * ★ 为什么需要它（缺陷 F11）：
 *   改前插件对 `mode` 的校验只有两道**事后**判据：
 *     ① `sessionController.create({ agentPreset })` 抛不抛；
 *     ② 建完之后读会话头 `meta.agentPreset` 与请求值**相不相等**。
 *   两道都不是"事前知道有哪些合法值"：名字打错时，要么宿主抛一句看不懂的话，
 *   要么宿主静默回落到默认档、由 ② 拦下 —— 而那时会话**已经建出来了**。
 *
 * ★ 宿主确实有可枚举的接口（本文件的事实来源，读的是 DSH 的 app.asar，不是猜的）：
 *   `@deepseek-ai/dsh-agent-preset-registry` 里 `AgentPresetRegistry` 的构造函数是
 *   `super(ctx, "agentPresets")` ⇒ 它在 Cordis 上注册的服务名就是 **`agentPresets`**。
 *   该类对外有：
 *     · `async list()`            —— 枚举全部已注册 preset（内部 `[...this.definitions.values()]`）
 *     · `async resolve(id)`       —— 解析一个 id；**认不出时抛的错里带
 *                                    `available: [...this.definitions.keys()]`**
 *     · `readDocument(agentPreset)`、`select(...)`、`get defaultId()`
 *                                    （`defaultId = selectedDefault ?? default`）
 *   ⇒ 所以插件**可以**事前枚举并校验，不必靠 create 抛错。
 *
 * ★ 三条纪律（与全项目一致）：
 *   ① **查不到就说查不到**：服务不在 / `list()` 不可用 ⇒ 如实标注"未校验"，**不拦派活**
 *      （宿主形态可能不带这个服务；因为查不到就拒绝派活 = 把插件自己的探测能力
 *       变成了派活的前提，那是另一件事）；
 *   ② **认不出就拦住**：服务在、枚举成功、而请求的 preset 不在名单里 ⇒ 拒绝派活，
 *      并把**合法取值**一并交给调用方（这正是不许"静默回落到默认档"的落点）；
 *   ③ 不缓存：每次派活现查（preset 是插件注册出来的，随时会变）。
 */

/** Cordis 服务名 —— 从 DSH 的 `super(ctx, "agentPresets")` 读出来的。 */
export const PRESET_SERVICE = 'agentPresets'

/** 读宿主服务（不抛）。 */
function readService(ctx, name) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return null
  try {
    return ctx.get(name) ?? null
  } catch {
    return null
  }
}

const isFn = (o, k) => o !== null && typeof o === 'object' && typeof o[k] === 'function'

/**
 * 枚举宿主上已注册的 preset。
 * @returns {Promise<{checked:boolean, ids:string[], defaultId:string|null, why:string}>}
 *          `checked:false` = **没校验成**（服务不在 / 接口不可用），不是"校验通过"。
 */
export async function listPresets(ctx) {
  const reg = readService(ctx, PRESET_SERVICE)
  if (reg === null) {
    return { checked: false, ids: [], defaultId: null, why: `宿主没有暴露 ${PRESET_SERVICE} 服务 ⇒ 枚举不到合法 preset（如实登记，不猜）` }
  }
  let defaultId = null
  try {
    const d = reg.defaultId
    if (typeof d === 'string' && d.length > 0) defaultId = d
  } catch {
    /* 读不到默认档不影响枚举 */
  }
  if (!isFn(reg, 'list')) {
    return { checked: false, ids: [], defaultId, why: `${PRESET_SERVICE} 服务在，但没有 list() ⇒ 枚举不到合法 preset（如实登记）` }
  }
  try {
    const raw = await reg.list()
    const ids = []
    for (const item of Array.isArray(raw) ? raw : []) {
      const id = typeof item === 'string' ? item : (item?.id ?? null)
      if (typeof id === 'string' && id.length > 0) ids.push(id)
    }
    if (ids.length === 0) {
      return { checked: false, ids, defaultId, why: `${PRESET_SERVICE}.list() 返回空 ⇒ 不当作"没有任何合法 preset"（那是把探测失败当成结论）` }
    }
    return { checked: true, ids, defaultId, why: '' }
  } catch (err) {
    return { checked: false, ids: [], defaultId, why: `${PRESET_SERVICE}.list() 抛错 ⇒ 枚举不到合法 preset：${String(err?.message ?? err)}` }
  }
}

/** 从宿主的报错里捞 `available`（registry 认不出 id 时自己会带）。 */
function availableFromError(err) {
  const a = err?.available ?? err?.cause?.available ?? null
  if (Array.isArray(a)) return a.filter((x) => typeof x === 'string' && x.length > 0)
  return []
}

/**
 * 校验一个 preset 名。
 * @returns {Promise<{checked:boolean, ok:boolean, ids:string[], defaultId:string|null, why:string}>}
 *   · `checked:true, ok:true`  —— 枚举到了，且请求值在名单里
 *   · `checked:true, ok:false` —— 枚举到了，请求值**不在**名单里（调用方应拒绝派活）
 *   · `checked:false`          —— 没能校验（服务不在/接口不可用）；**不是通过，也不是失败**
 */
export async function validatePreset(ctx, preset) {
  const want = typeof preset === 'string' ? preset.trim() : ''
  if (want.length === 0) {
    return { checked: false, ok: false, ids: [], defaultId: null, why: '模式槽是空串 ⇒ 没有可校验的目标（调用方应自行拒绝）' }
  }
  const listed = await listPresets(ctx)
  if (listed.checked) {
    const ok = listed.ids.includes(want)
    return {
      checked: true,
      ok,
      ids: listed.ids,
      defaultId: listed.defaultId,
      why: ok ? '' : `宿主上没有名为 ${want} 的 preset（合法取值：${listed.ids.join(' / ')}）`,
    }
  }
  // 枚举不成，退一步：直接问 resolve()，认不出时它自己会把 available 带出来。
  const reg = readService(ctx, PRESET_SERVICE)
  if (reg !== null && isFn(reg, 'resolve')) {
    try {
      await reg.resolve(want)
      return { checked: true, ok: true, ids: [], defaultId: listed.defaultId, why: '' }
    } catch (err) {
      const available = availableFromError(err)
      if (available.length > 0) {
        return {
          checked: true,
          ok: available.includes(want),
          ids: available,
          defaultId: listed.defaultId,
          why: `宿主上没有名为 ${want} 的 preset（合法取值：${available.join(' / ')}）`,
        }
      }
      return { checked: false, ok: false, ids: [], defaultId: listed.defaultId, why: `${listed.why}；${PRESET_SERVICE}.resolve() 也没给出可选名单：${String(err?.message ?? err)}` }
    }
  }
  return { checked: false, ok: false, ids: [], defaultId: listed.defaultId, why: listed.why }
}

/** 一行话（给派活文案用）；**永远说清"校验了没有"**。 */
export function describePresetCheck(v) {
  if (v === null || v === undefined) return '模式未校验（调用方没跑校验）—— 不当作通过'
  if (!v.checked) return `模式**未校验**（${v.why}）`
  if (v.ok) return `模式已校验：宿主上确实有 ${v.ids.length} 个 preset，请求值在名单里${v.defaultId === null ? '' : `（宿主默认档 ${v.defaultId}）`}`
  return `模式校验**不通过**：${v.why}`
}
