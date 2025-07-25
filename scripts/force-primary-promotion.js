#!/usr/bin/env node

// force-primary-promotion.js - MongoDB Primary 강제 승격
require('dotenv').config();
const mongoose = require('mongoose');

async function forcePrimaryPromotion() {
  try {
    console.log('🎯 MongoDB Primary 강제 승격 시작...');
    console.log('⚠️  경고: 이 작업은 일시적인 서비스 중단을 일으킬 수 있습니다!');
    
    // MongoDB 연결 (현재 노드에 연결)