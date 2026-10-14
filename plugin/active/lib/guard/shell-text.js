/**
 * dsh-pipeline · 守门 · **shell 文本的"命令位置"切分**
 * ============================================================================
 * -----------------------------------------------------------------------------
 * 修的是哪条缺陷（真机端到端 T-20261015-bb30bc 实测，缺陷 ⑧）
 * -----------------------------------------------------------------------------
 * 现场：主对话跑了一条**纯读**的多行命令（`Get-Content` 读 `cordis.yml` 与
 * `.pipeline-update-last-stamp.txt`，顺手比对两份插件的 `package.json`），被拒：
 *
 *     [pipeline] 拒绝：角色「main」不得通过 shell 修改项目文件。
 *     命令片段：…
 *     原因：测试/审核不得替编写改代码；shell 旁路与文件工具受同一套规则约束。
 *
 * **二分定位到的真凶**：那条命令里有这么一行**回显用的横幅**——
 *
 *     "== 两份插件里有 patch 配置的痕迹吗 =="
 *
 * `SHELL_WRITE_RE` 里有 `patch` 这个词，而它是**在整段文本上就地匹配**的
 * ⇒ 引号里、只是要打印出来的那个英文单词，被当成了 `patch` 命令。
 * 加上同一段脚本里出现了项目根路径（`mentionsProtectedPath` 为真）——
 * 两个条件一起成立 ⇒ **纯读命令被判定成"改项目文件"**。
 *
 * 同一份文件用 `Select-String` 搜符号能过，就是因为那条命令里**没有** `patch` 这个词 ——
 * 用户看到的"搜索放行 / 读正文被拒"这个不对称，**不是**有意设计的区分，就是这一条误判。
 *
 * -----------------------------------------------------------------------------
 * 判据修正：**写动词必须在"命令位置"上**
 * -----------------------------------------------------------------------------
 * 一条命令里的**引号内容**如果是被输出/回显的字面量，它就不是命令。
 * 所以把 `SHELL_WRITE_RE` 的匹配对象从"整段原文"改成"**去掉引号内容之后的文本**"：
 *
 *   · `"… 有 patch 配置的痕迹 …"`  ⇒ 引号被抹掉 ⇒ **不再命中**（缺陷 ⑧ 修的正是这一条）；
 *   · `Set-Content "C:\x" 'y'`      ⇒ 动词在引号**外** ⇒ 照旧命中；
 *   · `copy a b` / `patch -p1 < x`  ⇒ 未加引号 ⇒ 照旧命中。
 *
 * ★★ **这不是放宽**（两条硬论证）：
 *   ① **内联解释器那一支一个字没动**：`pwsh -Command "Set-Content x"` 这类"把写操作藏进
 *      引号里交给解释器执行"的写法，走的是 {@link INLINE_WRITE_API_RE}（对**原文**匹配，
 *      而且它自己那份名单里就有 `Set-Content|Out-File|Remove-Item|…`）⇒ 照旧拒；
 *   ② **重定向那一支也没动**：`shellRedirectTargets()` 本来就在引号抹掉之后的文本上找
 *      `>`，所以"引号里的 `>` 是字面量"这条既有口径与本次完全一致。
 *   ⇒ 收掉的只有"引号里恰好有个英文单词"这一类**从来没有被执行过**的假动词。
 *
 * @module dsh-pipeline/lib/guard/shell-text
 */

/** 去掉引号里的内容：引号里的 `>` / `|` / 写动词都是**字面量**，不是命令。 */
export function stripQuotedSegments(text) {
  return String(text).replace(/"(?:[^"\\`]|\\.|`.)*"|'[^']*'/g, '""')
}

/**
 * 写类 shell 动词（PowerShell 别名、cmd 命令、常见工具）。
 *
 * ⚠️ 与 {@link INLINE_WRITE_API_RE} 的分工：**这一份只在"命令位置"上匹配**
 *    （调用方先把引号抹掉）。要拦"藏在引号里交给解释器执行"的写法，用那一份。
 */
export const SHELL_WRITE_RE = /(^|[\s|;&(])(set-content|add-content|out-file|new-item|remove-item|move-item|copy-item|rename-item|ni|sc|ac|rm|del|erase|mv|cp|touch|mkdir|sed\s+-i|tee|truncate|dd|copy|xcopy|robocopy|move|ren|rename|git(?:\s+-[Cc]\s+\S+)*\s+(?:checkout|restore|apply|reset|clean|stash|am|rm|mv)|patch|perl\s+-[a-z]*i|curl\s[^|;&]*(?:-o|--output)\b|wget\s[^|;&]*-O\b|(?:invoke-webrequest|iwr)\s[^|;&]*-outfile\b|expand-archive|unzip)\b/i

/**
 * 这段文本里**在命令位置**上有没有写类动词。
 *
 * @param {string} text - shell 命令原文
 * @returns {boolean}
 */
export function hasWriteVerbOutsideQuotes(text) {
  return SHELL_WRITE_RE.test(stripQuotedSegments(text))
}

/**
 * 被引号包起来的那一段里提到了这些词，但它们**不在命令位置**上。
 *
 * 只用于**拒绝文案**：当"原文命中、命令位置不命中"时，告诉调用方
 * "你那个词只是字符串里的字面量"，免得它去反复改一条本来没错的命令。
 *
 * @param {string} text
 * @returns {string[]} 命中的词（去重，最多 5 个）
 */
export function quotedOnlyWriteWords(text) {
  const raw = String(text)
  const quoted = stripQuotedSegments(raw)
  if (quoted === raw) return []
  const out = []
  const re = new RegExp(SHELL_WRITE_RE.source, 'gi')
  let m = re.exec(raw)
  while (m !== null) {
    const w = String(m[2] ?? '').trim()
    if (w.length > 0 && !out.includes(w)) out.push(w)
    m = re.exec(raw)
  }
  return out.slice(0, 5)
}
