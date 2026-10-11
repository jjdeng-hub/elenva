// 内部状态标记块的输出侧兜底自检（lib/internal-state.ts）。
// 运行：node --experimental-strip-types tools/internal-state-selftest.mjs
import { stripInternalStateTags } from "../lib/internal-state.ts";

let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
  if (!ok) fail++;
};

const block = "<agent_status>\n工作记录\n</agent_status>";
check("剥离完整的 agent_status 块", stripInternalStateTags(`${block}\n正文`) === "正文");
check("剥离 elenva_todos 块", stripInternalStateTags("<elenva_todos>\n清单\n</elenva_todos>\n结论") === "结论");
check("剥离 memory_index 块", stripInternalStateTags("<memory_index>\n索引\n</memory_index>回答") === "回答");
check("多块同时剥离", stripInternalStateTags(`${block}\n甲\n<elenva_todos>x</elenva_todos>\n乙`) === "甲\n乙");
check("只有半个标记（流式中途）不动", stripInternalStateTags("前文 <agent_status> 后文") === "前文 <agent_status> 后文");
check("正文无标记原样返回", stripInternalStateTags("普通回复") === "普通回复");
check("正文只是提到标记名（无成对块）不动", stripInternalStateTags("标记名是 agent_status") === "标记名是 agent_status");

console.log(fail === 0 ? "\nSELFTEST: OK" : `\nSELFTEST: ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
