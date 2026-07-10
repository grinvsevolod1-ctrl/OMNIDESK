'use client'

import { useState, useEffect } from 'react'

interface Manager {
  id: string
  name: string
  email: string
  status: string
}

interface Channel {
  id: string
  name: string
  type: string
  status: string
  managerId: string | null
  sessionStatus: string
  phone: string | null
}

interface Conversation {
  id: string
  contactName: string
  contactHandle: string
  lastMessage: string
  unread: number
  status: string
  channelId: string
}

export function SecretDashboard() {
  const [managers, setManagers] = useState<Manager[]>([])
  const [channels, setChannels] = useState<Channel[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<'managers' | 'channels' | 'conversations' | 'messages' | 'stats'>('stats')
  
  const [formData, setFormData] = useState({
    name: '',
    type: 'whatsapp',
    managerId: '',
    phone: '',
    token: '',
    groupId: ''
  })

  const [dialogData, setDialogData] = useState({
    channelId: '',
    contactName: '',
    contactHandle: '',
    message: ''
  })

  const [messageData, setMessageData] = useState({
    conversationId: '',
    body: '',
    direction: 'out'
  })

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    setLoading(true)
    try {
      const [managersRes, channelsRes, convRes] = await Promise.all([
        fetch('/api/wijegniwjgwjog/managers'),
        fetch('/api/wijegniwjgwjog/channels'),
        fetch('/api/wijegniwjgwjog/conversations')
      ])
      
      const managersData = await managersRes.json()
      const channelsData = await channelsRes.json()
      const convData = await convRes.json()
      
      setManagers(managersData)
      setChannels(channelsData)
      setConversations(convData)
    } catch (error) {
      console.error('Error loading data:', error)
    } finally {
      setLoading(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    alert('✅ Скопировано!')
  }

  const createChannel = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const res = await fetch('/api/wijegniwjgwjog/create-channel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      })
      if (res.ok) {
        alert('✅ Канал создан!')
        loadData()
        setFormData({ name: '', type: 'whatsapp', managerId: '', phone: '', token: '', groupId: '' })
      } else {
        const error = await res.json()
        alert('❌ Ошибка: ' + error.message)
      }
    } catch (error) {
      alert('❌ Ошибка при создании канала')
    }
  }

  const createConversation = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const res = await fetch('/api/wijegniwjgwjog/create-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dialogData)
      })
      if (res.ok) {
        alert('✅ Диалог создан!')
        loadData()
        setDialogData({ channelId: '', contactName: '', contactHandle: '', message: '' })
      } else {
        const error = await res.json()
        alert('❌ Ошибка: ' + error.message)
      }
    } catch (error) {
      alert('❌ Ошибка при создании диалога')
    }
  }

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault()
    try {
      const res = await fetch('/api/wijegniwjgwjog/send-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(messageData)
      })
      if (res.ok) {
        alert('✅ Сообщение отправлено!')
        loadData()
        setMessageData({ conversationId: '', body: '', direction: 'out' })
      } else {
        const error = await res.json()
        alert('❌ Ошибка: ' + error.message)
      }
    } catch (error) {
      alert('❌ Ошибка при отправке')
    }
  }

  if (loading) return <div className="p-6 text-center text-lg">⏳ Загрузка...</div>

  const stats = {
    totalManagers: managers.length,
    totalChannels: channels.length,
    totalConversations: conversations.length,
    unread: conversations.reduce((sum, c) => sum + (c.unread || 0), 0)
  }

  return (
    <div className="p-6 max-w-7xl mx-auto bg-white min-h-screen">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold text-gray-800">🔒 Секретная панель</h1>
        <span className="text-sm text-gray-500">v2.0 • {new Date().toLocaleString()}</span>
      </div>

      {/* Статистика */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className="bg-blue-50 p-4 rounded-xl border border-blue-200">
          <div className="text-sm text-blue-600">Менеджеры</div>
          <div className="text-2xl font-bold text-blue-800">{stats.totalManagers}</div>
        </div>
        <div className="bg-green-50 p-4 rounded-xl border border-green-200">
          <div className="text-sm text-green-600">Каналы</div>
          <div className="text-2xl font-bold text-green-800">{stats.totalChannels}</div>
        </div>
        <div className="bg-purple-50 p-4 rounded-xl border border-purple-200">
          <div className="text-sm text-purple-600">Диалоги</div>
          <div className="text-2xl font-bold text-purple-800">{stats.totalConversations}</div>
        </div>
        <div className="bg-yellow-50 p-4 rounded-xl border border-yellow-200">
          <div className="text-sm text-yellow-600">Непрочитано</div>
          <div className="text-2xl font-bold text-yellow-800">{stats.unread}</div>
        </div>
      </div>

      {/* Табы */}
      <div className="flex gap-2 mb-4 flex-wrap">
        {[
          { id: 'stats', label: '📊 Статистика' },
          { id: 'managers', label: '👤 Менеджеры' },
          { id: 'channels', label: '📡 Каналы' },
          { id: 'conversations', label: '💬 Диалоги' },
          { id: 'messages', label: '✉️ Сообщения' }
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`px-4 py-2 rounded-lg transition ${
              activeTab === tab.id 
                ? 'bg-blue-600 text-white' 
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Контент */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        {activeTab === 'stats' && (
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-semibold text-gray-700 mb-3">📊 Общая статистика</h3>
              <div className="space-y-2 text-gray-600">
                <div>👤 Менеджеры: <span className="font-bold text-gray-800">{stats.totalManagers}</span></div>
                <div>📡 Каналы: <span className="font-bold text-gray-800">{stats.totalChannels}</span></div>
                <div>💬 Диалоги: <span className="font-bold text-gray-800">{stats.totalConversations}</span></div>
                <div>📨 Непрочитано: <span className="font-bold text-yellow-600">{stats.unread}</span></div>
              </div>
            </div>
            <div>
              <h3 className="font-semibold text-gray-700 mb-3">📡 Каналы по типам</h3>
              <div className="space-y-1 text-gray-600">
                {Object.entries(
                  channels.reduce((acc, ch) => {
                    acc[ch.type] = (acc[ch.type] || 0) + 1
                    return acc
                  }, {} as Record<string, number>)
                ).map(([type, count]) => (
                  <div key={type}><span className="font-medium">{type}:</span> <span className="font-bold text-gray-800">{count}</span></div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'managers' && (
          <div>
            <div className="flex justify-between items-center mb-3">
              <h3 className="font-semibold text-gray-700">👤 Менеджеры</h3>
              <button 
                onClick={() => window.location.href = '/admin/managers'}
                className="text-sm bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
              >
                Управление →
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 border-b border-gray-200">
                    <th className="pb-2">Имя</th>
                    <th className="pb-2">Email</th>
                    <th className="pb-2">Статус</th>
                    <th className="pb-2">UUID</th>
                    <th className="pb-2">Действие</th>
                  </tr>
                </thead>
                <tbody>
                  {managers.map((m) => (
                    <tr key={m.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="py-2 font-medium text-gray-800">{m.name}</td>
                      <td className="py-2 text-gray-600">{m.email}</td>
                      <td className="py-2">
                        <span className={`px-2 py-0.5 rounded text-xs ${
                          m.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                        }`}>
                          {m.status}
                        </span>
                      </td>
                      <td className="py-2 text-xs font-mono text-gray-500">{m.id}</td>
                      <td className="py-2">
                        <button 
                          onClick={() => copyToClipboard(m.id)}
                          className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700"
                        >
                          📋 Копировать
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'channels' && (
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-semibold text-gray-700 mb-3">📡 Создать канал</h3>
              <form onSubmit={createChannel} className="space-y-3">
                <input
                  type="text"
                  placeholder="Название"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none"
                  value={formData.name}
                  onChange={(e) => setFormData({...formData, name: e.target.value})}
                  required
                />
                <select
                  className="w-full border border-gray-300 rounded px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none"
                  value={formData.type}
                  onChange={(e) => setFormData({...formData, type: e.target.value})}
                >
                  <option value="whatsapp">WhatsApp</option>
                  <option value="vk">VK</option>
                  <option value="telegram">Telegram</option>
                  <option value="max">MAX</option>
                </select>
                <input
                  type="text"
                  placeholder="ID менеджера (необязательно)"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none"
                  value={formData.managerId}
                  onChange={(e) => setFormData({...formData, managerId: e.target.value})}
                />
                <input
                  type="text"
                  placeholder="Номер телефона"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none"
                  value={formData.phone}
                  onChange={(e) => setFormData({...formData, phone: e.target.value})}
                />
                <button type="submit" className="w-full bg-blue-600 text-white py-2 rounded hover:bg-blue-700">
                  🚀 Создать канал
                </button>
              </form>
            </div>
            <div>
              <h3 className="font-semibold text-gray-700 mb-3">📡 Все каналы</h3>
              <div className="max-h-96 overflow-y-auto space-y-2">
                {channels.map((ch) => (
                  <div key={ch.id} className="border border-gray-200 rounded-lg p-3 hover:bg-gray-50">
                    <div className="flex justify-between items-center">
                      <div>
                        <span className="font-medium text-gray-800">{ch.name}</span>
                        <span className="text-xs text-gray-500 ml-2">({ch.type})</span>
                        <span className={`text-xs ml-2 px-2 py-0.5 rounded ${
                          ch.status === 'connected' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                        }`}>
                          {ch.status}
                        </span>
                      </div>
                      <button 
                        onClick={() => copyToClipboard(ch.id)}
                        className="text-xs bg-gray-200 text-gray-700 px-2 py-1 rounded hover:bg-gray-300"
                      >
                        📋
                      </button>
                    </div>
                    {ch.phone && <div className="text-xs text-gray-500 mt-1">📱 {ch.phone}</div>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'conversations' && (
          <div className="grid md:grid-cols-2 gap-6">
            <div>
              <h3 className="font-semibold text-gray-700 mb-3">💬 Создать диалог</h3>
              <form onSubmit={createConversation} className="space-y-3">
                <select
                  className="w-full border border-gray-300 rounded px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none"
                  value={dialogData.channelId}
                  onChange={(e) => setDialogData({...dialogData, channelId: e.target.value})}
                  required
                >
                  <option value="">Выберите канал</option>
                  {channels.map((ch) => (
                    <option key={ch.id} value={ch.id}>{ch.name} ({ch.type})</option>
                  ))}
                </select>
                <input
                  type="text"
                  placeholder="Имя контакта"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none"
                  value={dialogData.contactName}
                  onChange={(e) => setDialogData({...dialogData, contactName: e.target.value})}
                  required
                />
                <input
                  type="text"
                  placeholder="Handle контакта"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none"
                  value={dialogData.contactHandle}
                  onChange={(e) => setDialogData({...dialogData, contactHandle: e.target.value})}
                  required
                />
                <textarea
                  placeholder="Первое сообщение"
                  className="w-full border border-gray-300 rounded px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none h-20 resize-none"
                  value={dialogData.message}
                  onChange={(e) => setDialogData({...dialogData, message: e.target.value})}
                />
                <button type="submit" className="w-full bg-green-600 text-white py-2 rounded hover:bg-green-700">
                  💬 Создать диалог
                </button>
              </form>
            </div>
            <div>
              <h3 className="font-semibold text-gray-700 mb-3">💬 Все диалоги</h3>
              <div className="max-h-96 overflow-y-auto space-y-2">
                {conversations.map((conv) => (
                  <div key={conv.id} className="border border-gray-200 rounded-lg p-3 hover:bg-gray-50">
                    <div className="flex justify-between items-center">
                      <div>
                        <span className="font-medium text-gray-800">{conv.contactName}</span>
                        <span className="text-xs text-gray-500 ml-2">{conv.contactHandle}</span>
                        {conv.unread > 0 && (
                          <span className="text-xs bg-yellow-500 text-white px-2 py-0.5 rounded ml-2">
                            {conv.unread} 📨
                          </span>
                        )}
                      </div>
                      <button 
                        onClick={() => copyToClipboard(conv.id)}
                        className="text-xs bg-gray-200 text-gray-700 px-2 py-1 rounded hover:bg-gray-300"
                      >
                        📋
                      </button>
                    </div>
                    <div className="text-sm text-gray-600 truncate mt-1">{conv.lastMessage}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'messages' && (
          <div className="max-w-2xl mx-auto">
            <h3 className="font-semibold text-gray-700 mb-3">✉️ Отправить сообщение</h3>
            <form onSubmit={sendMessage} className="space-y-3">
              <select
                className="w-full border border-gray-300 rounded px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none"
                value={messageData.conversationId}
                onChange={(e) => setMessageData({...messageData, conversationId: e.target.value})}
                required
              >
                <option value="">Выберите диалог</option>
                {conversations.map((conv) => (
                  <option key={conv.id} value={conv.id}>
                    {conv.contactName} ({conv.contactHandle})
                  </option>
                ))}
              </select>
              <select
                className="w-full border border-gray-300 rounded px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none"
                value={messageData.direction}
                onChange={(e) => setMessageData({...messageData, direction: e.target.value})}
              >
                <option value="out">📤 От менеджера</option>
                <option value="in">📥 От клиента</option>
              </select>
              <textarea
                placeholder="Текст сообщения"
                className="w-full border border-gray-300 rounded px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none h-24 resize-none"
                value={messageData.body}
                onChange={(e) => setMessageData({...messageData, body: e.target.value})}
                required
              />
              <button type="submit" className="w-full bg-purple-600 text-white py-2 rounded hover:bg-purple-700">
                ✉️ Отправить
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  )
}
