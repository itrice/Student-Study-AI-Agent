const PROMPT_INJECTION_PATTERNS = [
  {
    id: "ignore_instructions",
    pattern: /(忽略|无视|不要遵守|绕过)[^。！？\n]{0,24}(指令|规则|限制|提示词)/i
  },
  {
    id: "english_ignore_instructions",
    pattern: /ignore\s+(all\s+)?(previous|above|prior)\s+instructions?/i
  },
  {
    id: "system_prompt",
    pattern: /(系统提示|系统指令|system\s*prompt|developer\s*message)/i
  },
  {
    id: "role_override",
    pattern: /(你现在是|从现在开始你|扮演|act\s+as|jailbreak|\bDAN\b)/i
  },
  {
    id: "answer_demand",
    pattern: /(直接|马上|立刻)?(告诉|给|输出|写出|说出)[^。！？\n]{0,12}(标准)?答案/
  },
  {
    id: "control_token",
    pattern: /(<\|[^>]*\|>|\[INST\]|\[\/INST\]|###\s*(system|assistant)\b)/i
  },
  {
    id: "data_exfiltration",
    pattern: /(输出|打印|泄露)[^。！？\n]{0,18}(系统|提示词|密钥|api\s*key|数据库)/i
  }
];

export function detectPromptInjection(text) {
  const value = String(text || "");
  const matches = PROMPT_INJECTION_PATTERNS.filter((item) =>
    item.pattern.test(value)
  ).map((item) => item.id);
  return {
    detected: matches.length > 0,
    matches
  };
}

export function classifyUntrustedInput(text) {
  const injection = detectPromptInjection(text);
  return {
    promptInjection: injection.detected,
    matches: injection.matches,
    answerRequest: /(直接|马上|立刻|只要)[^。！？\n]{0,12}(答案|结果)/.test(
      String(text || "")
    )
  };
}
