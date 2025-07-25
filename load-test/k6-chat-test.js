import http from 'k6/http';
import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// 커스텀 메트릭
const wsConnections = new Counter('websocket_connections');
const wsConnectionFailures = new Counter('websocket_connection_failures');
const messagesReceived = new Counter('messages_received');
const messagesSent = new Counter('messages_sent');
const joinRoomSuccess = new Counter('join_room_success');
const joinRoomFailures = new Counter('join_room_failures');
const wsConnectionDuration = new Trend('websocket_