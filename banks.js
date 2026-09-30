/**
 * 题库注册表。
 *
 * 这份程序只装了一份题库：27 relax 1000 题。
 * 做题进度、错题本、笔记都存在你自己浏览器的 localStorage 里，
 * 不会上传到任何地方，也不会写进这些文件。
 */
window.QUIZ_BANKS = [
  {
    id: "relax1000",
    name: "27 relax 1000 题",
    subtitle: "数据结构 / 计组 / 操作系统 / 计网 四科章节练习",
    badge: "1000",
    tags: ["计算机统考", "分章节选择题"],
    data: "data/questions.js",
    assetBase: "./",
    storageKey: "relax1000_share_v1",
    total: 1576,
    ai: { subject: "计算机学科专业基础综合（408）" },
  },
];
