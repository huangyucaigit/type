const SCOPE = '仅针对本轮附带的这一条英语引用，结合所在句段理解，不分析其他引用。';
const STYLE = '用简洁中文回答，只讲关键点，默认1–3个重点，最多1个英文例句。';
const QUESTIONS = {
  structure: '这句话的主干和关键结构是什么？',
  collocations: '这里有哪些值得学习的词汇搭配？',
  imitation: '请基于这段引用给我一道仿写题，先不要给答案。',
  alternatives: '这里可以用哪些近义表达替换？有什么区别？',
  rewrite: '这段表达怎样写得更自然、准确？',
  writing: '这个表达可以怎样用到其他写作话题？',
};

export const QUICK_QUESTIONS = Object.freeze([
  { id: 'structure', label: '句子拆解', instruction: '先用一句话说明意思，再拆出句子主干，解释一个最关键的语法结构。若是段落，只挑一句最值得学习的句子。' },
  { id: 'collocations', label: '词汇搭配', instruction: '提取1–3个值得积累的词汇或搭配，说明当前语境中的含义及用法。单词或短语只围绕这个表达讲，不凑清单。' },
  { id: 'imitation', label: '仿写练习', instruction: '设计一道英语练习题：引用是单词或短语时，必须要求使用这个词或短语造句，不要只模仿上下文句式；引用是句子或段落时，设计保留关键结构的仿写题。先只给题目和必要提示，不给答案或示例；等我作答后，再点评并给参考版本。' },
  { id: 'alternatives', label: '同义替换', instruction: '给出2个适合当前语境的替换说法，简要说明区别。不能直接替换的表达要说明限制，不把近义词当成完全同义词。' },
  { id: 'rewrite', label: '自然改写', instruction: '检查表达是否自然、准确，给一个保留原意的改写版本，简要解释最关键的修改。原文已经很好就明确说明，不强行改写或虚构错误。' },
  { id: 'writing', label: '写作应用', instruction: '提取一个可以迁移到其他话题的表达或句式，说明写作用法，并给一个新话题的英文例句。以自然准确为先，不堆砌高级词，不打分。' },
].map(item => Object.freeze({ ...item, question: QUESTIONS[item.id], prompt: `${SCOPE}${item.instruction}${STYLE}` })));

// Cheap UI hints only: no model call and no change to the selected text or context.
export function referenceKind(reference) {
  const text = reference?.text?.trim() || '';
  const words = text.match(/[A-Za-z]+(?:['’\-][A-Za-z]+)*/g) || [];
  const endings = text.match(/[.!?。！？]+(?=\s|$)/gu) || [];
  if (words.length <= 1 || (words.length <= 6 && !endings.length && !/\n/.test(text))) return 'expression';
  if (endings.length <= 1 && words.length <= 80 && !/\n\s*\n/.test(text)) return 'sentence';
  return 'passage';
}

export function recommendedQuestions(reference) {
  const ids = referenceKind(reference) === 'expression' ? ['collocations', 'alternatives']
    : referenceKind(reference) === 'sentence' ? ['structure', 'imitation', 'rewrite']
      : ['collocations', 'writing', 'imitation'];
  return ids.map(id => QUICK_QUESTIONS.find(item => item.id === id));
}

export function questionTarget(references, messages, targetId = '') {
  const prior = messages.filter(message => message.role === 'user').flatMap(message => message.metadata?.references || []);
  const reference = references.find(ref => ref.id === targetId) || [...prior].reverse().find(ref => ref.id === targetId)
    || references.at(-1) || prior.at(-1);
  if (!reference) return null;
  const index = references.findIndex(ref => ref.id === reference.id);
  return { reference, label: index >= 0 ? `针对引用 ${index + 1}` : '继续学习上次引用' };
}
