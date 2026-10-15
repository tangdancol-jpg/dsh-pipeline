// 功能开关的**门面**：只做转出，实现按职责拆在 lib/switch/ 下。
/**
 * dsh-pipeline · 功能开关（客户端 UI ↔ 宿主机制之间的那根线）—— 门面
 * ============================================================================
 * 「多 AI 协调功能」的开 / 关。**开** = 编排 + 守门 + 状态机全管；
 * **关** = 本插件不再拦任何调用、不再往任何会话注入消息（回到普通 DSH 行为），
 * 只剩"流水线的写操作被拒"这一条**故意**保留。
 *
 * ---------------------------------------------------------------------------
 * 文件布局（对外导出名与拆分前逐一相同，调用方不需要改 import）
 * ---------------------------------------------------------------------------
 *   switch/state.js       状态**本身**：落盘文件 ↔ 内存的那根线 + 唯一读法
 *   switch/gate.js        ★ **统一闸门**：`isEnabled()` / `shouldFire(hookId)`
 *                         + 受管**面清单** `SWITCH_SURFACES`
 *   switch/text.js        关掉时的**文案唯一出处**（工具返回 / 启动日志 / UI 同一份）
 *   switch/audit.js        拦截**计数/观测**（"off 时无 hook 生效"靠它断言，不看文案）
 *   switch/mechanisms.js   周期机制（巡检 / 孤儿单自恢复）⇄ 开关的起停
 *   switch/waker-gate.js   唤醒投递的开关外壳（唯一咽喉包一层）
 *
 * ★ 为什么必须拆（用户原话：「分文件，分文件」）：改前"开关"只是**若干处各自为政的
 *   `sw.isOn()` 读取** —— 守门读了、席位工具面收紧读了、写操作拒绝读了，
 *   而四条拦截缝与唤醒器**一条都没读**，于是"关"只关掉了一半。
 *   拆开之后，"所有拦截面都问同一个闸门"变成一条**可核对**的结构约束。
 *
 * ★ 同步性是硬要求：`guardReason` 是**同步**遍历（`dsh-tools:2928`），
 *   所以判据必须是同步的内存读，不能 await、不能读盘。
 *
 * @module dsh-pipeline/lib/switch
 */

export { SWITCH_STATE_VERSION, createSwitch, defaultSwitchStateFile, readSwitchState } from './switch/state.js'
export { GATE, SWITCH_SURFACES, guardVerdict, isEnabled, shouldFire } from './switch/gate.js'
export { mutatingOffRefusal, offModeCopy, offModeReport, offModeStartupLines } from './switch/text.js'
export { createHookAudit, createSeamGate } from './switch/audit.js'
export { createMechanismItems, createSwitchDrivenMechanisms } from './switch/mechanisms.js'
export { withSwitchGate } from './switch/waker-gate.js'
