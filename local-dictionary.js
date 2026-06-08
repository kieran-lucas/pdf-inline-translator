'use strict';

window.LocalDictionary = (() => {
  const EN_VI = Object.freeze({
    study: 'học tập',
    education: 'giáo dục',
    student: 'học sinh',
    teacher: 'giáo viên',
    school: 'trường học',
    university: 'đại học',
    lesson: 'bài học',
    chapter: 'chương',
    section: 'mục',
    example: 'ví dụ',
    exercise: 'bài tập',
    question: 'câu hỏi',
    answer: 'câu trả lời',
    problem: 'vấn đề',
    solution: 'giải pháp',
    method: 'phương pháp',
    result: 'kết quả',
    conclusion: 'kết luận',
    introduction: 'giới thiệu',
    definition: 'định nghĩa',
    theorem: 'định lý',
    proof: 'chứng minh',
    formula: 'công thức',
    function: 'hàm',
    variable: 'biến',
    value: 'giá trị',
    number: 'số',
    equation: 'phương trình',
    graph: 'đồ thị',
    table: 'bảng',
    figure: 'hình',
    page: 'trang',
    text: 'văn bản',
    word: 'từ',
    sentence: 'câu',
    paragraph: 'đoạn văn',
    language: 'ngôn ngữ',
    english: 'tiếng Anh',
    vietnamese: 'tiếng Việt',
    history: 'lịch sử',
    culture: 'văn hóa',
    society: 'xã hội',
    family: 'gia đình',
    work: 'công việc',
    research: 'nghiên cứu',
    science: 'khoa học',
    computer: 'máy tính',
    data: 'dữ liệu',
    system: 'hệ thống',
    model: 'mô hình',
    algorithm: 'thuật toán',
    program: 'chương trình',
    memory: 'bộ nhớ',
    cache: 'bộ nhớ đệm',
    performance: 'hiệu suất',
    translation: 'bản dịch',
    meaning: 'ý nghĩa',
    important: 'quan trọng',
    common: 'phổ biến',
    different: 'khác nhau',
    similar: 'tương tự',
    compare: 'so sánh',
    explain: 'giải thích',
    describe: 'mô tả',
    analyze: 'phân tích',
    evaluate: 'đánh giá',
    create: 'tạo',
    build: 'xây dựng',
    improve: 'cải thiện',
    use: 'sử dụng',
    learn: 'học',
    read: 'đọc',
    write: 'viết',
    speak: 'nói',
    listen: 'nghe',
  });

  function isSingleWord(text) {
    return /^[\p{L}\p{N}_]+(?:['\u2019\u2018\-\u2010\u2011][\p{L}\p{N}_]+)*$/u.test(text);
  }

  function lookup(text, sourceLang, targetLang) {
    const normalized = String(text || '').trim();
    if (!normalized || !isSingleWord(normalized)) return null;
    if (targetLang !== 'vi') return null;
    if (sourceLang && sourceLang !== 'auto' && sourceLang !== 'en' && sourceLang !== 'eng') return null;
    return EN_VI[normalized.toLowerCase()] || null;
  }

  return { lookup };
})();
