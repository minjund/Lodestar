'use strict';

const USER_INPUT_TOOL_PATTERN = /^(?:request_user_input|ask_user_question|askuserquestion|request_input|get_user_input)$/i;

function isUserInputTool(name) {
  return USER_INPUT_TOOL_PATTERN.test(String(name || '').trim());
}

function conversationalTail(value) {
  const text = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\r\n]*`/g, ' ')
    .replace(/^\s*>.*$/gm, ' ')
    .replace(/!?(?:\[[^\]]*\])\([^\s)]+(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.slice(-1600).trim();
}

function assistantRequestsUserResponse(value) {
  const tail = conversationalTail(value);
  if (!tail) return false;

  // A question at the end of the final prose is the strongest provider-neutral signal.
  if (/[?？]\s*(?:["')\]}>*_~]|&gt;)*\s*$/.test(tail)) return true;

  const koreanRequest = /(?:선택|골라|알려|말씀|답변|확인|결정|지정|입력|보내|첨부|업로드|제공)(?:해|하여|해서|해\s*)?(?:주세요|주십시오|주실래요|바랍니다)(?:[.!:：]|\s|$)/.test(tail);
  const englishRequest = [
    // A polite request may follow introductory prose, so "please"/"kindly"
    // is a strong signal wherever it appears.
    /\b(?:please|kindly)\s+(?:choose|select|confirm|tell\s+me|let\s+me\s+know|provide|send|share|enter|upload|attach)\b/i,
    // Bare imperatives are requests only at the beginning of prose or a new
    // sentence. This avoids treating technical words such as "resend" or a
    // Korean completion report containing "attach" as user-input requests.
    /(?:^|[\r\n]+|[.!?]\s+)\s*(?:choose|select|confirm|tell\s+me|let\s+me\s+know|provide|send|share|enter|upload|attach)\b/i,
    /(?:^|[\r\n]+|[.!?]\s+)\s*(?:can|could|would|will)\s+you\s+(?:choose|select|confirm|provide|send|share|enter|upload|attach)\b/i,
  ].some(pattern => pattern.test(tail));
  const chineseRequest = /(?:请选择|请确认|请提供|请告诉|请回复|请上传)/.test(tail);
  const directRequest = koreanRequest || englishRequest || chineseRequest;
  if (!directRequest) return false;

  // Ignore common courtesy offers that do not block the task.
  if (/(?:궁금한|추가 질문|도움이 필요).{0,30}(?:알려|말씀).{0,12}주세요[.!]?$/i.test(tail)) return false;
  if (/let me know if (?:you have|there are) (?:any )?(?:questions|issues)[.!]?$/i.test(tail)) return false;
  return true;
}

module.exports = { assistantRequestsUserResponse, isUserInputTool };
