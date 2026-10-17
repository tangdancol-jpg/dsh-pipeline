/**
 * dsh-pipeline · 收尾清理工具（`pipeline_task_purge`）
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（真机端到端 T-20261015-bb30bc 实测，缺陷 ⑦）
 * -----------------------------------------------------------------------------
 * 「没有任何'删除任务'的工具」：唯一官方出口 `cancel` 只改状态、文件全留着；
 * 主对话想用 shell 手工删又被守门「main 不得通过 shell 修改项目文件」挡住
 * ⇒ `.pipeline` 只能靠人**去资源管理器里手删**（真机上就是这么绕的）。
 *
 * -----------------------------------------------------------------------------
 * 这条通道为什么不是"给主对话开后门"
 * -----------------------------------------------------------------------------
 * 它**不碰** shell 判据（那条字符串匹配的边界一个字没动），而是给"收尾清理"
 * 一个**具名、可审计、有前置条件**的入口：
 *
 *   · **只有主对话**能调（守门白名单 `pipeline_task_purge: ['main']` —— 与关单同档）；
 *   · **只认终态单**（`closed` / `cancelled`）—— 在跑的单一个字节都不许动；
 *   · **默认进回收站**（`.pipeline/_trash/<任务id>-<时刻>/`，可恢复），
 *     永久删要显式 `mode: "delete"` **且** `confirm: true`；
 *   · **先留痕后动手**：墓碑行落 `.pipeline/_purge-log.jsonl`（在被删目录**之外**，
 *     删完仍然查得到）。
 *
 * @module dsh-pipeline/lib/tools/purge
 */

import { ROLE } from '../roles.js'
import { S, tool, resolveActor } from './kit.js'
// ★ 拒绝文案的**唯一出处**（`lib/errors/text.js`）：本文件只换成引用，字面值未动。
import { taskNotFound } from '../errors/text.js'
import { PURGE_LOG_NAME, TRASH_DIR_NAME } from '../store/purge.js'

/**
 * 收尾清理工具。
 *
 * @param {object} ctx - `buildTools` 闭包里本组用到的名字
 */
export function buildPurgeTools(ctx) {
  const { deps, store, load } = ctx

  const taskPurge = tool(deps, {
    name: 'pipeline_task_purge',
    mutating: true,
    description:
      '【主对话专用】收尾清理：把一张**已到终态**的任务单（已关闭 / 已取消）归档或删除。' +
      '默认 `mode: "trash"` ⇒ 移到 `.pipeline/_trash/<任务id>-<时刻>/`，**可恢复**；' +
      '`mode: "delete"` 才真的删（还要 `confirm: true`）。' +
      '★ 只认终态单（在跑的单一个字节都不许动）；★ 先写墓碑账本再动手（删完仍可追溯）。' +
      '★ 这条工具**不碰 shell 判据** —— 它是"收尾清理"的具名入口，不是给主对话开 shell 后门。',
    parameters: {
      task_id: S('string', '任务 ID（必须是**终态**单：已关闭 / 已取消）'),
      mode: S('string', '★ 清理方式：trash = 移到回收站（默认，可恢复）｜delete = 永久删除', { enum: ['trash', 'delete'] }),
      confirm: S('boolean', '★ `mode: "delete"` 时必须显式传 true（永久删除不可恢复）'),
      reason: S('string', '为什么要清（会写进墓碑账本，可空）'),
      role_token: S('string', '角色令牌'),
    },
    output: {
      ok: S('boolean', '是否成功'),
      summary: S('string', '给人看的摘要'),
      mode: S('string', '实际用的方式（trash / delete）'),
      moved_to: S('string', '归档到哪（delete 时为空串）'),
      files: S('number', '清掉了几个文件'),
      bytes: S('number', '清掉了多少字节'),
    },
    async run(args, exec) {
      const empty = { mode: '', moved_to: '', files: 0, bytes: 0 }
      const actor = resolveActor(args, exec, deps)
      if (actor.ok !== true) return { ok: false, ...empty, summary: actor.error }
      // ★ 与关单同档：只有主对话能收尾（守门那一层也有一道白名单，这里是同源的早退）。
      if (actor.role !== ROLE.MAIN) {
        return {
          ok: false,
          ...empty,
          summary:
            `拒绝清理：只有**主对话**能做收尾清理，当前角色是「${actor.role}」。\n` +
            '★ 为什么：清理是不可逆的数据动作，责任必须落在一个明确的角色上 —— 与关单同档。',
        }
      }
      const task = await load(String(args.task_id ?? ''))
      if (task === null) return { ok: false, ...empty, summary: taskNotFound(args.task_id) }

      const mode = args.mode === 'delete' ? 'delete' : 'trash'
      /**
       * ★ **永久删除要显式确认**。
       *
       * 为什么单独要一个 `confirm` 而不是"给了 mode 就算确认"：
       * 模型很容易把 `mode: "delete"` 顺手写进参数（它只是"看起来更彻底"），
       * 而这一步**不可恢复**（含那张单的全部验收留痕）。多要一个显式布尔，
       * 代价是一次参数，收益是"误删"从"一次手滑"变成"要连写两个字段"。
       */
      if (mode === 'delete' && args.confirm !== true) {
        return {
          ok: false,
          ...empty,
          summary:
            `拒绝永久删除「${task.id}」：\`mode: "delete"\` 必须同时给 \`confirm: true\`。\n` +
            '★ 这一步**不可恢复**（连那张单的验收留痕一起没）。\n' +
            `  · 只是想让列表干净 ⇒ 用默认的 \`mode: "trash"\`（移到 .pipeline/${TRASH_DIR_NAME}/，随时能捞回来）；\n` +
            '  · 确实要永久删 ⇒ 再调一次并带上 `confirm: true`。',
        }
      }

      const res = await store.purgeTask({
        taskId: task.id,
        mode,
        by: actor.role,
        reason: typeof args.reason === 'string' ? args.reason : '',
      })
      if (res.ok !== true) return { ok: false, ...empty, summary: res.error }

      const mb = (res.bytes / 1024 / 1024).toFixed(2)
      const head =
        mode === 'trash'
          ? `已归档「${task.id}」（**可恢复**）：${res.moved_to}`
          : `已**永久删除**「${task.id}」—— 不可恢复。`
      return {
        ok: true,
        mode,
        moved_to: res.moved_to ?? '',
        files: res.files,
        bytes: res.bytes,
        summary:
          `${head}\n` +
          `  · 清掉 ${res.files} 个文件 / ${mb} MB\n` +
          `  · 墓碑账本：.pipeline/${PURGE_LOG_NAME}（**在被删目录之外**，所以删完仍可追溯：谁在什么时候、以什么理由、删了哪张单）\n` +
          (mode === 'trash'
            ? `★ 想捞回来：把 .pipeline/${TRASH_DIR_NAME}/ 下那一份移回 .pipeline/<任务id> 即可（名字里带着清理时刻）。`
            : '★ 永久删除已生效：本轮之后没有任何入口能把它捞回来。'),
      }
    },
  })

  return { taskPurge }
}
