#!/usr/bin/env node

// loadtest-monitor.js - 부하테스트 전용 실시간 모니터링
const axios = require('axios');
const fs = require('fs').promises;

class LoadTestMonitor {
  constructor() {
    this.alerts = [];
    this.metrics = [];
    this.startTime = Date.now();
    this.isRunning = false;
  }

  async startMonitoring(apiUrl = 'http://localhost:8080') {
    console.log('🔥 부하테스트 모니터링 시작...');
    this.isRunning = true;
    
    while (this.isRunning) {
      try {
        const metrics = await this.collectMetrics(apiUrl);
        this.analyzeMetrics(metrics);
        this.displayRealTimeStatus(metrics);
        
        // 1초마다 체크 (부하테스트 중이므로 빈번하게)
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error('❌ 모니터링 오류:', error.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  async collectMetrics(apiUrl) {
    const responses = await Promise.allSettled([
      axios.get(`${apiUrl}/health`),
      axios.get(`${apiUrl}/metrics`),
      axios.get(`${apiUrl}/extreme-survival`)
    ]);

    const health = responses[0].status === 'fulfilled' ? responses[0].value.data : null;
    const metrics = responses[1].status === 'fulfilled' ? responses[1].value.data : null;
    const survival = responses[2].status === 'fulfilled' ? responses[2].value.data : null;

    const timestamp = Date.now();
    const uptime = Math.floor((timestamp - this.startTime) / 1000);

    return {
      timestamp,
      uptime,
      health,
      metrics,
      survival,
      responseTime: responses[0].status === 'fulfilled' ? 
        (Date.now() - timestamp) : 9999
    };
  }

  analyzeMetrics(data) {
    if (!data.metrics) return;

    const { metrics, survival } = data;
    const memPercent = metrics.memory.rss / 1200 * 100; // 1200MB 기준
    const userCount = metrics.connections.users;

    // 위험 수준 판단
    let riskLevel = 'safe';
    if (memPercent > 90 || userCount > 4000) riskLevel = 'critical';
    else if (memPercent > 80 || userCount > 3000) riskLevel = 'warning';
    else if (memPercent > 70 || userCount > 2000) riskLevel = 'caution';

    // 경고 생성
    if (riskLevel !== 'safe') {
      this.addAlert(riskLevel, `메모리: ${memPercent.toFixed(1)}%, 사용자: ${userCount}명`);
    }

    // 성능 저하 감지
    if (data.responseTime > 1000) {
      this.addAlert('critical', `응답시간: ${data.responseTime}ms (심각)`);
    } else if (data.responseTime > 500) {
      this.addAlert('warning', `응답시간: ${data.responseTime}ms (지연)`);
    }

    // 메트릭 저장
    this.metrics.push({
      timestamp: data.timestamp,
      memPercent: memPercent,
      userCount: userCount,
      responseTime: data.responseTime,
      riskLevel: riskLevel
    });

    // 최근 100개만 유지
    if (this.metrics.length > 100) {
      this.metrics.shift();
    }
  }

  addAlert(level, message) {
    const alert = {
      timestamp: Date.now(),
      level,
      message
    };
    
    this.alerts.unshift(alert);
    
    // 최근 20개만 유지
    if (this.alerts.length > 20) {
      this.alerts.pop();
    }
  }

  displayRealTimeStatus(data) {
    console.clear();
    
    // 헤더
    console.log('🔥🔥🔥 t3.small 부하테스트 실시간 모니터링 🔥🔥🔥');
    console.log('=' .repeat(70));
    
    if (!data.metrics) {
      console.log('❌ 서버 연결 실패');
      return;
    }

    const { metrics, survival } = data;
    const memPercent = metrics.memory.rss / 1200 * 100;
    const userCount = metrics.connections.users;

    // 핵심 지표
    console.log(`⏱️  테스트 시간: ${Math.floor(data.uptime / 60)}분 ${data.uptime % 60}초`);
    console.log(`👥 접속자 수: ${userCount.toLocaleString()}명`);
    console.log(`🧠 메모리: ${metrics.memory.rss}MB / 1200MB (${memPercent.toFixed(1)}%)`);
    console.log(`⚡ 응답시간: ${data.responseTime}ms`);
    console.log(`🏥 서버상태: ${this.getHealthEmoji(memPercent, userCount)} ${this.getRiskLevel(memPercent, userCount)}`);
    
    // 진행률 바
    const progressBar = this.createProgressBar(userCount, 6000, 50);
    console.log(`📊 목표진행: ${progressBar} (${userCount}/6000)`);
    
    // 생존 모드 상태
    if (survival) {
      console.log(`🛡️  생존모드: ${survival.survivalMode.toUpperCase()}`);
      
      const features = [
        `AI: ${userCount < 500 ? '✅' : '❌'}`,
        `파일: ${userCount < 800 ? '✅' : '❌'}`,
        `리액션: ${userCount < 1200