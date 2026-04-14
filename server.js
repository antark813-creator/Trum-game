const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game State ───────────────────────────────────────────────────────────────
const suits = ['♠', '♥', '♦', '♣'];
const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function createDeck() {
  const deck = [];
  for (const suit of suits)
    for (const rank of ranks)
      deck.push({ suit, rank });
  return deck.sort(() => Math.random() - 0.5);
}

function rankValue(r) { return ranks.indexOf(r); }
function cardValue(card, trump) {
  const base = rankValue(card.rank);
  return card.suit === trump ? base + 100 : base;
}

// Rooms: { roomId: { players, game } }
const rooms = {};

function getRoom(roomId) { return rooms[roomId]; }

function broadcastRoom(roomId) {
  const room = getRoom(roomId);
  if (!room) return;
  // Send each player their own view
  room.players.forEach(p => {
    const socketId = p.socketId;
    const view = buildPlayerView(room, p.id);
    io.to(socketId).emit('gameState', view);
  });
}

function buildPlayerView(room, playerId) {
  const { game, players } = room;
  const me = players.find(p => p.id === playerId);
  return {
    roomId: room.roomId,
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      team: p.team,
      score: p.score,
      isConnected: p.isConnected,
      cardCount: game.hands[p.id] ? game.hands[p.id].length : 0,
      isSeen: game.seen[p.id] || false,
      currentBid: game.bids[p.id] || 0,
      folded: game.folded.includes(p.id),
    })),
    myCards: me ? (game.hands[me.id] || []) : [],
    myId: playerId,
    phase: game.phase,
    currentTurn: game.currentTurn,
    trump: game.trumpRevealed ? game.trump : null,
    trumpSuit: game.trump,
    trumpRevealed: game.trumpRevealed,
    trumpCard: game.trumpRevealed ? game.trumpCard : null,
    pot: game.pot,
    currentBet: game.currentBet,
    pit: game.pit,
    dealer: game.dealer,
    winner: game.winner,
    winTeam: game.winTeam,
    roundWinner: game.roundWinner,
    messages: room.messages,
    teamScores: room.teamScores,
    gameOver: room.gameOver,
    gameWinner: room.gameWinner,
    trickHistory: game.trickHistory,
    currentTrick: game.currentTrick,
    trickWinner: game.trickWinner,
    minPit: game.minPit,
    maxPit: game.maxPit,
    bonusPit: game.bonusPit,
  };
}

function newGame(room) {
  const deck = createDeck();
  const players = room.players;
  const hands = {};
  // Deal 13 cards each (52 / 4)
  players.forEach((p, i) => {
    hands[p.id] = deck.slice(i * 13, (i + 1) * 13);
  });
  // Trump card is last card of deck logically — pick separately
  const trumpCard = deck[51]; // last card
  // Actually deal 13 each = 52 total, trump comes from calling
  room.game = {
    phase: 'calling', // calling -> playing -> roundEnd
    hands,
    seen: {},
    folded: [],
    bids: {},
    pot: 0,
    currentBet: 0,
    trump: null,
    trumpCard: null,
    trumpRevealed: false,
    dealer: room.game ? (room.game.dealer + 1) % 4 : 0,
    currentTurn: null, // set after calling
    pit: 0,
    minPit: 4,
    maxPit: 9,
    bonusPit: 12,
    winner: null,
    winTeam: null,
    roundWinner: null,
    trickHistory: [],
    currentTrick: [],
    trickWinner: null,
    calledBy: null,
    calledPit: 0,
    calledTrump: null,
    passCount: 0,
    callTurn: room.game ? (room.game.dealer + 1) % 4 : 0,
  };
  room.gameOver = false;
  room.gameWinner = null;
}

function startRound(room) {
  newGame(room);
  broadcastRoom(room.roomId);
}

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // Create or join room
  socket.on('joinRoom', ({ roomId, playerName }) => {
    let room = rooms[roomId];
    if (!room) {
      room = {
        roomId,
        players: [],
        messages: [],
        teamScores: { A: 0, B: 0 },
        gameOver: false,
        gameWinner: null,
        game: { dealer: -1 },
      };
      rooms[roomId] = room;
    }

    // Check if reconnecting
    const existing = room.players.find(p => p.name === playerName);
    if (existing) {
      existing.socketId = socket.id;
      existing.isConnected = true;
      socket.join(roomId);
      socket.emit('joined', { playerId: existing.id, team: existing.team });
      broadcastRoom(roomId);
      return;
    }

    if (room.players.length >= 4) {
      socket.emit('error', 'Room is full');
      return;
    }

    const playerId = `p${room.players.length + 1}`;
    const team = room.players.length < 2 ? 'A' : 'B';
    // Team assignment: p1,p3 = A, p2,p4 = B (cross partners)
    const teamMap = ['A','B','A','B'];
    const team2 = teamMap[room.players.length];

    room.players.push({
      id: playerId,
      name: playerName,
      socketId: socket.id,
      team: team2,
      score: 0,
      isConnected: true,
    });

    socket.join(roomId);
    socket.emit('joined', { playerId, team: team2 });

    io.to(roomId).emit('playerJoined', {
      name: playerName,
      count: room.players.length,
      team: team2,
    });

    if (room.players.length === 4) {
      startRound(room);
    } else {
      broadcastRoom(roomId);
    }
  });

  // Calling phase: player calls trump + pit
  socket.on('callTrump', ({ roomId, playerId, trump, pit }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const game = room.game;
    if (game.phase !== 'calling') return;
    const playerIndex = room.players.findIndex(p => p.id === playerId);
    if (playerIndex !== game.callTurn) return;

    // Validate pit
    if (pit < game.minPit || pit > game.bonusPit) return;
    if (game.calledPit && pit <= game.calledPit) return;

    game.calledBy = playerId;
    game.calledPit = pit;
    game.calledTrump = trump;
    game.trump = trump;
    game.trumpCard = null;
    game.trumpRevealed = false;
    game.phase = 'playing';
    game.currentTurn = game.callTurn; // caller starts
    game.currentTrick = [];

    // Announce
    const caller = room.players.find(p => p.id === playerId);
    room.messages.push({
      type: 'system',
      text: `${caller.name} ডাকলেন: ${trump} trump, ${pit} পিট`,
      time: Date.now(),
    });

    broadcastRoom(roomId);
  });

  socket.on('passCalling', ({ roomId, playerId }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const game = room.game;
    if (game.phase !== 'calling') return;
    const playerIndex = room.players.findIndex(p => p.id === playerId);
    if (playerIndex !== game.callTurn) return;

    game.passCount = (game.passCount || 0) + 1;
    game.callTurn = (game.callTurn + 1) % 4;

    // If all passed, lowest bidder (first) must call
    if (game.passCount >= 4) {
      game.callTurn = (game.dealer + 1) % 4;
      game.passCount = 0;
      game.minPit = 4; // forced call
    }

    broadcastRoom(roomId);
  });

  // Reveal trump
  socket.on('revealTrump', ({ roomId, playerId }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const game = room.game;
    if (game.calledBy !== playerId) return;
    game.trumpRevealed = true;
    room.messages.push({
      type: 'system',
      text: `Trump reveal হয়েছে: ${game.trump}`,
      time: Date.now(),
    });
    broadcastRoom(roomId);
  });

  // Play a card
  socket.on('playCard', ({ roomId, playerId, card }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const game = room.game;
    if (game.phase !== 'playing') return;
    const playerIndex = room.players.findIndex(p => p.id === playerId);
    if (playerIndex !== game.currentTurn) return;

    // Remove card from hand
    const hand = game.hands[playerId];
    const cardIndex = hand.findIndex(c => c.suit === card.suit && c.rank === card.rank);
    if (cardIndex === -1) return;
    hand.splice(cardIndex, 1);

    // Add to current trick
    game.currentTrick.push({ playerId, card });

    // If 4 cards played, determine trick winner
    if (game.currentTrick.length === 4) {
      const leadSuit = game.currentTrick[0].card.suit;
      let best = game.currentTrick[0];
      for (const play of game.currentTrick) {
        const c = play.card;
        const b = best.card;
        const cVal = c.suit === game.trump ? rankValue(c.rank) + 100 : (c.suit === leadSuit ? rankValue(c.rank) : -1);
        const bVal = b.suit === game.trump ? rankValue(b.rank) + 100 : (b.suit === leadSuit ? rankValue(b.rank) : -1);
        if (cVal > bVal) best = play;
      }

      const winner = room.players.find(p => p.id === best.playerId);
      game.trickHistory.push({ trick: [...game.currentTrick], winner: best.playerId });
      game.trickWinner = best.playerId;
      game.currentTrick = [];

      // Count tricks per team
      const teamTricks = { A: 0, B: 0 };
      for (const t of game.trickHistory) {
        const w = room.players.find(p => p.id === t.winner);
        if (w) teamTricks[w.team]++;
      }

      // Check if all tricks done (13 tricks)
      if (game.trickHistory.length === 13) {
        // Determine round result
        const caller = room.players.find(p => p.id === game.calledBy);
        const callerTeam = caller.team;
        const callerTeamTricks = teamTricks[callerTeam];
        const calledPit = game.calledPit;

        let pointsA = 0, pointsB = 0;

        if (callerTeamTricks >= calledPit) {
          // Caller team wins
          let pts = calledPit;
          if (callerTeamTricks >= 10) pts = callerTeamTricks; // bonus
          if (callerTeam === 'A') pointsA = pts;
          else pointsB = pts;
          // Opponent gets their tricks
          const oppTricks = 13 - callerTeamTricks;
          if (callerTeam === 'A') pointsB = oppTricks;
          else pointsA = oppTricks;
        } else {
          // Caller team loses — opponent gets full pit points
          const oppTeam = callerTeam === 'A' ? 'B' : 'A';
          const pts = calledPit;
          if (oppTeam === 'A') pointsA = pts;
          else pointsB = pts;
          // Caller gets 0 or negative
          if (callerTeam === 'A') pointsA = -calledPit;
          else pointsB = -calledPit;
        }

        room.teamScores.A += pointsA;
        room.teamScores.B += pointsB;

        game.phase = 'roundEnd';
        game.roundResult = { teamTricks, pointsA, pointsB, callerTeam, calledPit, callerTeamTricks };

        room.messages.push({
          type: 'system',
          text: `রাউন্ড শেষ! Team A: ${pointsA > 0 ? '+' : ''}${pointsA}, Team B: ${pointsB > 0 ? '+' : ''}${pointsB}`,
          time: Date.now(),
        });

        // Check game over
        if (room.teamScores.A >= 50) {
          room.gameOver = true;
          room.gameWinner = 'A';
          room.messages.push({ type: 'system', text: '🏆 Team A জিতেছে!', time: Date.now() });
        } else if (room.teamScores.B >= 50) {
          room.gameOver = true;
          room.gameWinner = 'B';
          room.messages.push({ type: 'system', text: '🏆 Team B জিতেছে!', time: Date.now() });
        }
      } else {
        // Next turn is trick winner
        game.currentTurn = room.players.findIndex(p => p.id === best.playerId);
      }
    } else {
      // Next player's turn
      game.currentTurn = (game.currentTurn + 1) % 4;
    }

    broadcastRoom(roomId);
  });

  // Seen / Blind toggle
  socket.on('setSeen', ({ roomId, playerId }) => {
    const room = getRoom(roomId);
    if (!room) return;
    room.game.seen[playerId] = true;
    broadcastRoom(roomId);
  });

  // Chat message
  socket.on('chatMessage', ({ roomId, playerId, text }) => {
    const room = getRoom(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    room.messages.push({
      type: 'chat',
      sender: player.name,
      team: player.team,
      text,
      time: Date.now(),
    });
    // Keep last 50 messages
    if (room.messages.length > 50) room.messages.shift();
    broadcastRoom(roomId);
  });

  // Next round
  socket.on('nextRound', ({ roomId }) => {
    const room = getRoom(roomId);
    if (!room || room.gameOver) return;
    startRound(room);
  });

  // Disconnect
  socket.on('disconnect', () => {
    for (const roomId in rooms) {
      const room = rooms[roomId];
      const player = room.players.find(p => p.socketId === socket.id);
      if (player) {
        player.isConnected = false;
        io.to(roomId).emit('playerDisconnected', { name: player.name });
        broadcastRoom(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
