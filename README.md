# mooc-learner

MOOC 课程自动学习工具 - OpenClaw Skill

## 简介

这是一个用于自动完成 MOOC 视频课程学习的工具，支持：
- 自动分析课程章节学习状态
- 智能处理各类弹窗
- 进度保存与恢复
- 学习统计报告

## 安装

```bash
npm install
```

## 使用方法

```bash
node scripts/learn-courses.js
```

## 配置

在 `scripts/learn-courses.js` 中修改 `CONFIG` 对象：

```javascript
CONFIG = {
  COURSES: [
    {
      id: 'course-1',
      name: '课程名称',
      url: 'https://mooc.ctt.cn/#/study/subject/detail/xxx'
    }
  ],
  // ...
}
```

## 功能

- ✅ 自动检测章节学习状态
- ✅ 智能处理学习弹窗
- ✅ 进度自动保存
- ✅ 支持多课程
- ✅ 防屏保机制
- ✅ 学习统计报告

## 依赖

- Node.js 18+
- Playwright
- Chrome/Chromium 浏览器

## 许可证

MIT
