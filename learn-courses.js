const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ==================== 配置常量 ====================
const CONFIG = {
  // 目标URL（支持多个课程）
  COURSES: [
    {
      id: 'course-1',
      name: '课程1',
      url: 'https://mooc.ctt.cn/#/study/subject/detail/dfa84528-8f8c-4b0a-a049-81bf3e86276e'
    }
  ],
  
  // 视频学习配置
  VIDEO: {
    MAX_WAIT_SECONDS: 3600,
    CHECK_INTERVAL: 5000
  },
  
  // 浏览器配置
  BROWSER: {
    HEADLESS: false,
    CHANNEL: 'chrome',
    ARGS: ['--start-maximized', '--disable-blink-features=AutomationControlled']
  },
  
  // 进度保存配置
  PROGRESS: {
    SAVE_FILE: './learning-progress.json',
    SAVE_INTERVAL: 30000
  }
};

// 全局状态
let shouldStop = false;
let browser = null;
let progressData = {
  courses: {},
  stats: {
    totalTime: 0,
    completedChapters: 0,
    failedChapters: 0,
    sessions: []
  }
};

// ==================== 进度管理 ====================
function loadProgress() {
  try {
    if (fs.existsSync(CONFIG.PROGRESS.SAVE_FILE)) {
      const data = fs.readFileSync(CONFIG.PROGRESS.SAVE_FILE, 'utf-8');
      progressData = JSON.parse(data);
      console.log('✓ 已加载上次学习进度');
      return true;
    }
  } catch (err) {
    console.log('加载进度失败:', err.message);
  }
  return false;
}

function saveProgress() {
  try {
    fs.writeFileSync(CONFIG.PROGRESS.SAVE_FILE, JSON.stringify(progressData, null, 2));
  } catch (err) {
    console.log('保存进度失败:', err.message);
  }
}

function updateProgress(courseId, chapterIndex, status, timeSpent = 0) {
  if (!progressData.courses[courseId]) {
    progressData.courses[courseId] = {
      chapters: {},
      completedChapters: []
    };
  }
  
  progressData.courses[courseId].chapters[chapterIndex] = {
    status,
    timeSpent,
    timestamp: new Date().toISOString()
  };
  
  if (status === 'completed') {
    if (!progressData.courses[courseId].completedChapters.includes(chapterIndex)) {
      progressData.courses[courseId].completedChapters.push(chapterIndex);
    }
    progressData.stats.completedChapters++;
  } else if (status === 'failed') {
    progressData.stats.failedChapters++;
  }
  
  progressData.stats.totalTime += timeSpent;
  saveProgress();
}

// ==================== 工具函数 ====================
function formatTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) return `${hours}时${minutes}分${secs}秒`;
  else if (minutes > 0) return `${minutes}分${secs}秒`;
  else return `${secs}秒`;
}

function logSeparator(title = '') {
  console.log('\n========================================');
  if (title) {
    console.log(title);
    console.log('========================================\n');
  }
}

// ==================== 智能弹窗处理 ====================
async function handlePopupSmart(page, elapsedSeconds) {
  try {
    // 文本匹配弹窗
    const textPatterns = [
      { text: '学习计时中', button: ['确定', '我已知悉'] },
      { text: '亲爱的学员', button: ['确定', '我已知悉'] },
      { text: '学习完成', button: ['确定', '关闭', '知道了'] },
      { text: '播放结束', button: ['确定', '下一章', '继续'] }
    ];
    
    for (const pattern of textPatterns) {
      const content = await page.content();
      if (content.includes(pattern.text)) {
        for (const btnText of pattern.button) {
          const buttons = await page.locator(`button:has-text("${btnText}"), a:has-text("${btnText}")`).all();
          for (const btn of buttons) {
            try {
              if (await btn.isVisible()) {
                await btn.click();
                console.log(`[${formatTime(elapsedSeconds)}] 关闭弹窗: ${btnText}`);
                await page.waitForTimeout(500);
                break;
              }
            } catch (e) {}
          }
        }
      }
    }
    
    // ESC关闭
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    
  } catch (error) {}
}

// ==================== 获取需要学习的章节 ====================
async function getChaptersToLearn(page, courseId) {
  logSeparator('分析章节学习状态');

  try {
    await page.waitForSelector('[id^="D395finishStatus-"]', { timeout: 15000 });
  } catch (err) {}

  await page.waitForTimeout(2000);

  const reviewElements = await page.locator('text=复习').all();
  const startElements = await page.locator('text=开始学习').all();
  const continueElements = await page.locator('text=继续学习').all();

  let statusElements = [...reviewElements, ...startElements, ...continueElements];
  const chapters = [];

  for (let i = 0; i < statusElements.length; i++) {
    try {
      const elem = statusElements[i];
      const text = await elem.textContent();
      const actionText = text?.trim() || '';

      let needLearn = false;
      if (actionText.includes('开始学习') || actionText.includes('继续学习')) {
        needLearn = true;
      } else if (actionText.includes('复习')) {
        needLearn = false;
      }

      const isCompleted = progressData.courses[courseId]?.completedChapters?.includes(i + 1);
      
      const statusIcon = needLearn && !isCompleted ? '⏳' : '✓';
      const learnStatus = isCompleted ? '(已完成)' : '';
      console.log(`第 ${i + 1} 章节: ${statusIcon} [${actionText}] ${learnStatus}`);

      chapters.push({
        index: i + 1,
        courseId: `chapter-${i + 1}`,
        actionText: actionText,
        needLearn: needLearn && !isCompleted
      });
    } catch (err) {}
  }

  const needLearnCount = chapters.filter(c => c.needLearn).length;
  console.log(`总章节数: ${chapters.length}, 需要学习: ${needLearnCount} 章\n`);

  return chapters.filter(c => c.needLearn);
}

// ==================== 进入章节学习 ====================
async function startChapterLearning(page, chapter, context) {
  console.log(`\n开始学习第 ${chapter.index} 章`);

  try {
    // 优先查找"继续学习"
    const continueElement = page.locator('button:has-text("继续学习"), a:has-text("继续学习"), span:has-text("继续学习")').first();
    if (await continueElement.count() > 0) {
      const pagePromise = context.waitForEvent('page', { timeout: 10000 });
      
      try {
        await continueElement.evaluate(el => el.click());
        console.log('✓ 点击"继续学习"按钮');

        const newPage = await Promise.race([
          pagePromise,
          page.waitForTimeout(3000).then(() => null)
        ]);

        if (newPage) {
          console.log('✓ 检测到新标签页打开');
          return { success: true, page: newPage };
        }
      } catch (err) {}
    }

    // 查找"开始学习"
    const startElement = page.locator('button:has-text("开始学习"), a:has-text("开始学习"), span:has-text("开始学习")').first();
    if (await startElement.count() > 0) {
      const pagePromise = context.waitForEvent('page');
      
      await startElement.evaluate(el => el.click());
      console.log('✓ 点击"开始学习"按钮');

      const newPage = await Promise.race([
        pagePromise,
        page.waitForTimeout(3000).then(() => null)
      ]);

      if (newPage) {
        return { success: true, page: newPage };
      }

      // 检查当前页面
      await page.waitForTimeout(2000);
      const hasVideo = await page.locator('video').count() > 0;
      if (hasVideo) {
        return { success: true, page: page };
      }
    }
    
    return { success: false, page: null };
    
  } catch (error) {
    console.error('点击学习按钮失败:', error.message);
    return { success: false, page: null };
  }
}

// ==================== 监控视频学习完成 ====================
async function waitForVideoCompletion(page) {
  logSeparator('等待视频学习完成');
  
  const startTime = Date.now();
  const maxWaitSeconds = CONFIG.VIDEO.MAX_WAIT_SECONDS;
  let completionCount = 0;
  let lastSaveTime = Date.now();

  while (!shouldStop) {
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);

    if (elapsedSeconds > maxWaitSeconds) {
      console.log(`\n⚠ 等待超时 (${formatTime(maxWaitSeconds)})`);
      return false;
    }

    try {
      // 智能弹窗处理
      await handlePopupSmart(page, elapsedSeconds);

      // 检测学习完成
      const completionPopup = await page.locator('text=学习完成, text=播放结束, text=已完成, text=恭喜').all();
      if (completionPopup.length > 0) {
        console.log('\n✓ 检测到学习完成');
        
        const closeBtn = page.locator('button:has-text("确定"), button:has-text("关闭")').first();
        if (await closeBtn.count() > 0) {
          try { await closeBtn.click(); } catch(e) {}
        }
        return true;
      }

      // 检测返回章节列表
      const backToChapter = await page.locator('div.small.inline-block[id^="D395finishStatus-"]').count() > 0;
      if (backToChapter && elapsedSeconds > 10) {
        completionCount++;
        if (completionCount >= 3) {
          console.log('\n✓ 已返回章节列表页面');
          return true;
        }
      }

      // 检测视频结束
      const videoElements = await page.locator('video').all();
      for (const video of videoElements) {
        const ended = await video.evaluate(v => v.ended).catch(() => false);
        if (ended) {
          console.log('\n✓ 视频播放已结束');
          await page.waitForTimeout(2000);
          return true;
        }
      }

      // 定期保存进度
      if (Date.now() - lastSaveTime > CONFIG.PROGRESS.SAVE_INTERVAL) {
        saveProgress();
        lastSaveTime = Date.now();
      }

      // 进度输出
      if (elapsedSeconds % 300 === 0 && elapsedSeconds > 0) {
        console.log(`学习进行中... (${formatTime(elapsedSeconds)})`);
      }

      // 防屏保
      if (elapsedSeconds % 60 === 0 && elapsedSeconds > 10) {
        try {
          await page.evaluate(() => {
            const body = document.body;
            if (body) {
              const event = new MouseEvent('click', { bubbles: true, clientX: 100, clientY: window.innerHeight - 50 });
              body.dispatchEvent(event);
            }
          });
        } catch (err) {}
      }

    } catch (error) {
      console.log(`[检测错误] ${error.message}`);
    }

    await page.waitForTimeout(CONFIG.VIDEO.CHECK_INTERVAL);
  }
  
  return false;
}

// ==================== 关闭播放页 ====================
async function closeVideoPage(page) {
  console.log('\n关闭播放页，返回章节列表...');
  
  try {
    const closeButton = page.locator('button:has-text("返回"), button:has-text("关闭")').first();
    if (await closeButton.count() > 0) {
      await closeButton.click({ timeout: 5000 });
      await page.waitForTimeout(2000);
      return true;
    }
    
    await page.goBack();
    await page.waitForTimeout(2000);
    
    const backToChapter = await page.locator('div.small.inline-block[id^="D395finishStatus-"]').count() > 0;
    if (backToChapter) return true;
    
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    return true;
    
  } catch (error) {
    console.log('关闭播放页失败:', error.message);
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      return true;
    } catch (err) {
      return false;
    }
  }
}

// ==================== 自动学习流程 ====================
async function autoLearningProcess(page, context, currentPageUrl = null) {
  const courses = CONFIG.COURSES;
  
  for (let c = 0; c < courses.length; c++) {
    const course = courses[c];
    
    logSeparator(`开始学习: ${course.name}`);
    
    if (c === 0 && currentPageUrl) {
      console.log(`使用当前页面: ${currentPageUrl}\n`);
    } else {
      console.log(`URL: ${course.url}\n`);
      await page.goto(course.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
    }
    
    // 学习课程
    let maxRounds = 3;
    for (let round = 1; round <= maxRounds; round++) {
      console.log(`\n===== 第 ${round} 轮学习检测 =====\n`);
      
      const chaptersToLearn = await getChaptersToLearn(page, course.id);
      
      if (chaptersToLearn.length === 0) {
        console.log(`\n✓ 所有章节已完成学习！`);
        break;
      }

      for (let i = 0; i < chaptersToLearn.length; i++) {
        const chapter = chaptersToLearn[i];
        const chapterStartTime = Date.now();

        console.log(`\n进度: ${i + 1}/${chaptersToLearn.length}`);

        const result = await startChapterLearning(page, chapter, context);
        if (!result.success || !result.page) {
          console.log(`⚠ 跳过第 ${chapter.index} 章`);
          updateProgress(course.id, chapter.index, 'failed', 0);
          continue;
        }

        const videoPage = result.page;
        const completed = await waitForVideoCompletion(videoPage);
        
        const timeSpent = Math.floor((Date.now() - chapterStartTime) / 1000);
        
        if (completed) {
          updateProgress(course.id, chapter.index, 'completed', timeSpent);
          console.log(`✓ 第 ${chapter.index} 章学习完成 (用时: ${formatTime(timeSpent)})`);
        } else {
          updateProgress(course.id, chapter.index, 'incomplete', timeSpent);
        }

        await closeVideoPage(videoPage);

        if (videoPage !== page) {
          await videoPage.close();
        }

        await page.waitForTimeout(3000);
      }
    }
  }
  
  return true;
}

// ==================== 主流程 ====================
async function main() {
  console.log('\n========================================');
  console.log('MOOC 自动学习工具');
  console.log('版本: 2.0 (智能增强版)');
  console.log('========================================\n');

  loadProgress();

  console.log('启动浏览器...\n');

  const browser = await chromium.launch({
    headless: CONFIG.BROWSER.HEADLESS,
    channel: CONFIG.BROWSER.CHANNEL,
    args: CONFIG.BROWSER.ARGS
  });

  const context = await browser.newContext();
  let page = await context.newPage();

  // 使用第一个课程URL
  const firstCourse = CONFIG.COURSES[0];
  console.log(`打开页面: ${firstCourse.url}\n`);
  await page.goto(firstCourse.url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  await page.waitForTimeout(2000);

  // 等待用户确认
  console.log('='.repeat(50));
  console.log('请确认浏览器页面，如果需要可以手动切换标签页');
  console.log('等待 30 秒后开始自动学习...');
  console.log('='.repeat(50));

  for (let i = 30; i > 0; i--) {
    process.stdout.write(`\r等待中... ${i} 秒 `);
    await page.waitForTimeout(1000);
  }

  console.log('\n\n开始自动学习...\n');

  // 获取当前页面
  const currentPageUrl = page.url();
  await autoLearningProcess(page, context, currentPageUrl);

  console.log('\n========================================');
  console.log('✓ 课程学习完成!');
  console.log('========================================\n');
  
  saveProgress();

  console.log('按 Ctrl+C 退出...');
  await new Promise(() => {});
}

main().catch(console.error);
