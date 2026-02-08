import { io } from 'socket.io-client';

const SOCKET_URL = process.env.NODE_ENV === 'production' 
    ? 'https://code-editor-app-euzi.onrender.com' 
    : 'http://localhost:10000'; 

export const socket = io(SOCKET_URL, {
    autoConnect: false,
    transports: ['websocket'], 
});