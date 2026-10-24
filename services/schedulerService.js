const cron = require('node-cron');
const db = require('../database/db');
const transferService = require('./transferService');

class SchedulerService {
  constructor() {
    this.cronTask = null;
    this.currentExpression = null;
    this.isEnabled = false;
    this.lastRunTime = null;
    this.nextRunTime = null;
  }

  /**
   * Initialize scheduler from database settings
   */
  init() {
    const settings = db.getSettings();
    this.currentExpression = settings.scheduleInterval || '0 * * * *';
    this.isEnabled = settings.scheduleEnabled !== false;

    db.addLog('info', 'SCHEDULER', `Initializing background scheduler. Schedule: "${this.currentExpression}", Enabled: ${this.isEnabled}`);

    if (this.isEnabled) {
      this.start(this.currentExpression);
    }
  }

  /**
   * Start or restart the scheduled cron job
   */
  start(expression = null) {
    if (expression) {
      this.currentExpression = expression;
    }

    if (!cron.validate(this.currentExpression)) {
      db.addLog('error', 'SCHEDULER', `Invalid cron expression: "${this.currentExpression}". Falling back to hourly "0 * * * *".`);
      this.currentExpression = '0 * * * *';
    }

    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }

    this.isEnabled = true;
    db.updateSettings({ scheduleEnabled: true, scheduleInterval: this.currentExpression });

    try {
      this.cronTask = cron.schedule(this.currentExpression, async () => {
        this.lastRunTime = new Date().toISOString();
        db.addLog('info', 'SCHEDULER', `⏰ Scheduled automation cycle triggered at ${this.lastRunTime}`);
        try {
          await transferService.processAllActiveTemplates();
        } catch (err) {
          db.addLog('error', 'SCHEDULER', `Scheduled execution error: ${err.message}`);
        }
      });

      db.addLog('success', 'SCHEDULER', `Scheduler is running with pattern "${this.currentExpression}"`);
      return { success: true, message: `Scheduler started with pattern: ${this.currentExpression}` };
    } catch (err) {
      this.isEnabled = false;
      db.addLog('error', 'SCHEDULER', `Failed to start scheduler: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Stop / pause the scheduler
   */
  stop() {
    if (this.cronTask) {
      this.cronTask.stop();
      this.cronTask = null;
    }
    this.isEnabled = false;
    db.updateSettings({ scheduleEnabled: false });
    db.addLog('warn', 'SCHEDULER', 'Scheduler paused by administrator.');
    return { success: true, message: 'Scheduler stopped.' };
  }

  /**
   * Trigger immediate transfer run
   */
  async triggerNow() {
    this.lastRunTime = new Date().toISOString();
    db.addLog('info', 'SCHEDULER', `⚡ Manual "Run Now" triggered by administrator at ${this.lastRunTime}`);
    try {
      const result = await transferService.processAllActiveTemplates();
      return { success: true, result };
    } catch (err) {
      db.addLog('error', 'SCHEDULER', `"Run Now" execution failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get scheduler status
   */
  getStatus() {
    return {
      isEnabled: this.isEnabled,
      expression: this.currentExpression,
      lastRunTime: this.lastRunTime,
      isProcessing: transferService.isProcessing,
    };
  }
}

module.exports = new SchedulerService();
