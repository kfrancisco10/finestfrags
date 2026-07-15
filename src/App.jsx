import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Shield, Users, RefreshCw, Send, Plus, Trash2, Calendar, Database } from 'lucide-react';

// Connect to Supabase using Vite environment variables
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Calculates current calendar week identifier in Philippine Standard Time (GMT+8)
 * Format output: "YYYY-Www" (e.g., "2026-W29")
 */
function getPHWeekIdentifier() {
  const now = new Date();
  const phTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
  
  const target = new Date(phTime.valueOf());
  const dayNr = (phTime.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  const weekNum = 1 + Math.ceil((firstThursday - target) / 604800000);
  const year = target.getFullYear();
  
  return `${year}-W${weekNum.toString().padStart(2, '0')}`;
}

export default function App() {
  const [members, setMembers] = useState([]);
  const [weeklyLoot, setWeeklyLoot] = useState({});
  const [totalFragments, setTotalFragments] = useState(10);
  const [discordWebhook, setDiscordWebhook] = useState('');
  const [newMemberName, setNewMemberName] = useState('');
  const [newMemberColumn, setNewMemberColumn] = useState('A');
  const [allocationResult, setAllocationResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState('');

  const currentWeek = getPHWeekIdentifier();

  useEffect(() => {
    if (SUPABASE_URL && SUPABASE_ANON_KEY) {
      fetchData();
    }
    const savedWebhook = localStorage.getItem('ro_discord_webhook');
    if (savedWebhook) setDiscordWebhook(savedWebhook);
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      // 1. Fetch live queue structure
      const { data: memberData, error: memberErr } = await supabase
        .from('guild_members')
        .select('*')
        .order('column_type', { ascending: true })
        .order('queue_order', { ascending: true });
      
      if (!memberErr && memberData) setMembers(memberData);

      // 2. Query weekly allocations dynamically using the week_identifier column
      const { data: allocationData, error: allocErr } = await supabase
        .from('daily_allocations')
        .select('member_name, fragments')
        .eq('week_identifier', currentWeek);

      if (!allocErr && allocationData) {
        // Map individual allocations to an object structure: { memberName: totalWeeklyCount }
        const lootSumMap = {};
        allocationData.forEach(row => {
          const count = Array.isArray(row.fragments) ? row.fragments.length : 0;
          lootSumMap[row.member_name] = (lootSumMap[row.member_name] || 0) + count;
        });
        setWeeklyLoot(lootSumMap);
      }
    } catch (err) {
      console.error("Data synchronization error:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddMember = async (e) => {
    e.preventDefault();
    if (!newMemberName.trim()) return;

    const columnMembers = members.filter(m => m.column_type === newMemberColumn);
    const nextOrder = columnMembers.length > 0 ? Math.max(...columnMembers.map(m => m.queue_order)) + 1 : 1;

    const { error } = await supabase
      .from('guild_members')
      .insert([{ name: newMemberName.trim(), column_type: newMemberColumn, queue_order: nextOrder }]);

    if (!error) {
      setNewMemberName('');
      fetchData();
    }
  };

  const handleDeleteMember = async (id) => {
    const { error } = await supabase.from('guild_members').delete().eq('id', id);
    if (!error) fetchData();
  };

  const calculateAllocation = () => {
    let availableFragments = parseInt(totalFragments) || 0;
    let fragmentCounter = 1;
    
    const listA = members.filter(m => m.column_type === 'A').sort((a,b) => a.queue_order - b.queue_order);
    const listB = members.filter(m => m.column_type === 'B').sort((a,b) => a.queue_order - b.queue_order);
    const listC = members.filter(m => m.column_type === 'C').sort((a,b) => a.queue_order - b.queue_order);

    const allocations = { A: [], B: [], C: [] };

    // --- CRITERIA A ---
    // Rule: Max 5 members per drop event. Each gets 3 fragments.
    const eligibleCountA = Math.min(5, listA.length);
    for (let i = 0; i < eligibleCountA; i++) {
      if (availableFragments >= 3) {
        const member = listA[i];
        const assigned = [fragmentCounter++, fragmentCounter++, fragmentCounter++];
        allocations.A.push({ name: member.name, id: member.id, fragments: assigned });
        availableFragments -= 3;
      }
    }

    // --- CRITERIA B ---
    // Rule: Sequential assignment. Each gets 2 fragments.
    let indexB = 0;
    while (availableFragments >= 2 && listB.length > 0 && indexB < listB.length) {
      const member = listB[indexB];
      const assigned = [fragmentCounter++, fragmentCounter++];
      allocations.B.push({ name: member.name, id: member.id, fragments: assigned });
      availableFragments -= 2;
      indexB++;
    }

    // --- CRITERIA C ---
    // Rule: Sequential assignment. Each gets 1 fragment.
    let indexC = 0;
    while (availableFragments >= 1 && listC.length > 0 && indexC < listC.length) {
      const member = listC[indexC];
      const assigned = [fragmentCounter++];
      allocations.C.push({ name: member.name, id: member.id, fragments: assigned });
      availableFragments -= 1;
      indexC++;
    }

    setAllocationResult({
      allocations,
      leftover: availableFragments,
      timestamp: new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' }) + " GMT+8"
    });
  };

  const commitAndPushToDiscord = async () => {
    if (!allocationResult) return;
    setLoading(true);
    setSaveStatus('');

    try {
      // 1. Prepare history entries to log in database
      const dbEntries = [];
      ['A', 'B', 'C'].forEach(col => {
        allocationResult.allocations[col].forEach(item => {
          dbEntries.push({
            member_name: item.name,
            column_type: col,
            fragments: item.fragments,
            week_identifier: currentWeek
          });
        });
      });

      // Write daily history to Supabase
      if (dbEntries.length > 0) {
        const { error: insertError } = await supabase
          .from('daily_allocations')
          .insert(dbEntries);
        if (insertError) throw insertError;
      }

      // 2. Update queue orders in master table to rotate recipients to back
      for (const col of ['A', 'B', 'C']) {
        const rewarded = allocationResult.allocations[col];
        if (rewarded.length === 0) continue;

        const colMembers = members.filter(m => m.column_type === col);
        let maxOrder = colMembers.length > 0 ? Math.max(...colMembers.map(m => m.queue_order)) : 0;

        for (const item of rewarded) {
          maxOrder += 1;
          await supabase
            .from('guild_members')
            .update({ queue_order: maxOrder })
            .eq('id', item.id);
        }
      }

      // 3. Post to Discord Channel
      if (discordWebhook) {
        localStorage.setItem('ro_discord_webhook', discordWebhook);
        
        let discordMessage = `⚔️ **PUPPET FRAGMENTS ALLOCATION LOG** ⚔️\n`;
        discordMessage += `📅 *Date: ${allocationResult.timestamp}*\n`;
        discordMessage += `🏷️ *Calendar Week: ${currentWeek}*\n`;
        discordMessage += `📦 *Total Allocated: ${totalFragments} pieces*\n\n`;

        if (allocationResult.allocations.A.length > 0) {
          discordMessage += `🔺 **CRITERIA A (3 Fragments - Max 5 Members)**\n`;
          allocationResult.allocations.A.forEach(m => {
            discordMessage += `• **${m.name}**: Fragments #${m.fragments.join(', ')}\n`;
          });
          discordMessage += `\n`;
        }

        if (allocationResult.allocations.B.length > 0) {
          discordMessage += `⚔️ **CRITERIA B (2 Fragments)**\n`;
          allocationResult.allocations.B.forEach(m => {
            discordMessage += `• **${m.name}**: Fragments #${m.fragments.join(', ')}\n`;
          });
          discordMessage += `\n`;
        }

        if (allocationResult.allocations.C.length > 0) {
          discordMessage += `🛡️ **CRITERIA C (1 Fragment)**\n`;
          allocationResult.allocations.C.forEach(m => {
            discordMessage += `• **${m.name}**: Fragment #${m.fragments[0]}\n`;
          });
          discordMessage += `\n`;
        }

        if (allocationResult.leftover > 0) {
          discordMessage += `⚠️ *Leftover count: ${allocationResult.leftover} pieces saved in vault.*\n`;
        }

        await fetch(discordWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: "Prontera Loot Officer",
            avatar_url: "https://i.imgur.com/83pZpGZ.png",
            content: discordMessage
          })
        });
      }

      setSaveStatus(`Success! Log saved for week ${currentWeek} and queue rotated.`);
      setAllocationResult(null);
      fetchData();
    } catch (err) {
      setSaveStatus('Database commit failed.');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 p-6">
      {/* Header Banner */}
      <header className="max-w-7xl mx-auto mb-8 border-b-4 border-double border-red-900/60 pb-6 flex flex-col md:flex-row justify-between items-center gap-4">
        <div>
          <h1 className="text-3xl font-black text-red-500 uppercase tracking-wider flex items-center gap-2" style={{ fontFamily: 'var(--ro-font-header)', fontSize: '1.4rem' }}>
            <span>⚔️</span> PUPPET FRAGMENTS ALLOCATOR
          </h1>
          <p className="text-neutral-500 text-xs mt-2 uppercase tracking-widest font-mono">Guild Vault System • Server Time (GMT+8)</p>
        </div>
        <div className="ro-window p-3 rounded-none text-xs flex items-center gap-3">
          <Calendar className="w-5 h-5 text-red-500" />
          <div>
            <p className="text-red-500 font-bold uppercase" style={{ fontFamily: 'var(--ro-font-header)', fontSize: '0.55rem' }}>DROP WINDOWS</p>
            <p className="text-neutral-300 font-mono mt-1">TUE, THU, SUN AT 9:55 PM</p>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Config Panel */}
        <div className="space-y-6 lg:col-span-1">
          <div className="ro-window relative overflow-hidden">
            <div className="ro-window-header text-white px-3 py-2 flex items-center gap-2">
              <span>🔧</span>
              <span>DISTRIBUTION PANEL</span>
            </div>
            
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-bold uppercase text-neutral-400 mb-2">Total Fragments Today</label>
                <input 
                  type="number" 
                  value={totalFragments} 
                  onChange={(e) => setTotalFragments(e.target.value)}
                  className="ro-input w-full p-3 font-bold text-lg rounded-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold uppercase text-neutral-400 mb-2">Discord Hook Endpoint</label>
                <input 
                  type="text" 
                  placeholder="https://discord.com/api/webhooks/..."
                  value={discordWebhook} 
                  onChange={(e) => setDiscordWebhook(e.target.value)}
                  className="ro-input w-full p-2.5 text-xs rounded-none"
                />
              </div>

              <button 
                onClick={calculateAllocation}
                className="ro-btn w-full py-3 text-sm font-bold"
              >
                Compute Allocation
              </button>
            </div>
          </div>

          {/* Add Guild Member Panel */}
          <div className="ro-window">
            <div className="ro-window-header text-white px-3 py-2 flex items-center gap-2">
              <span>➕</span>
              <span>ADD GUILD MEMBER</span>
            </div>
            <form onSubmit={handleAddMember} className="p-4 space-y-3">
              <input 
                type="text" 
                placeholder="Ragnarok Character IGN..." 
                value={newMemberName} 
                onChange={(e) => setNewMemberName(e.target.value)}
                className="ro-input w-full p-2.5 text-sm rounded-none"
              />
              <div className="grid grid-cols-3 gap-2">
                {['A', 'B', 'C'].map((col) => (
                  <button
                    key={col}
                    type="button"
                    onClick={() => setNewMemberColumn(col)}
                    className={`py-2 text-xs font-bold border transition ${newMemberColumn === col ? 'bg-red-950/40 border-red-600 text-red-400' : 'bg-neutral-950 border-neutral-800 text-neutral-400'}`}
                  >
                    Col {col}
                  </button>
                ))}
              </div>
              <button type="submit" className="ro-btn w-full py-2.5 text-xs">
                Insert to Roster
              </button>
            </form>
          </div>
        </div>

        {/* Center/Right Column: Interactive Display Screens */}
        <div className="lg:col-span-2 space-y-6">
          {allocationResult && (
            <div className="ro-window border-red-500">
              <div className="ro-window-header text-white px-3 py-2 flex justify-between items-center bg-red-950">
                <span className="flex items-center gap-2"><span>🎲</span> ALLOCATION PREVIEW DRAFT</span>
                <span className="text-[9px] uppercase font-mono text-red-400">Week: {currentWeek}</span>
              </div>
              
              <div className="p-5 space-y-6">
                {['A', 'B', 'C'].map((col) => (
                  <div key={col}>
                    <h3 className="text-xs font-bold uppercase text-red-500 border-b border-red-950 pb-1 mb-3">
                      Criteria {col} Drop List ({col === 'A' ? '3 Pcs Each' : col === 'B' ? '2 Pcs Each' : '1 Pc Each'})
                    </h3>
                    {allocationResult.allocations[col].length === 0 ? (
                      <p className="text-neutral-600 text-xs italic">No allocations in this tier</p>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {allocationResult.allocations[col].map((m) => (
                          <div key={m.id} className="bg-neutral-900/60 border border-red-950/30 p-3 flex justify-between items-center">
                            <span className="font-bold text-sm text-neutral-200">{m.name}</span>
                            <span className="text-xs font-mono bg-red-950/60 text-red-400 border border-red-900/40 px-2 py-0.5 rounded font-bold">
                              Fragments: {m.fragments.join(', ')}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}

                <div className="flex flex-col md:flex-row items-center gap-4 bg-neutral-950/60 border border-red-950 p-4">
                  <div className="flex-1">
                    <p className="text-xs font-bold text-neutral-400 uppercase">Save & Broadcast Loot</p>
                    <p className="text-[11px] text-neutral-500">Updates databases for Week {currentWeek} and pings the Discord webhook channel.</p>
                  </div>
                  <button
                    onClick={commitAndPushToDiscord}
                    disabled={loading}
                    className="ro-btn px-6 py-2.5 text-xs flex items-center gap-2"
                  >
                    <Send className="w-3.5 h-3.5" /> Commit & Push Log
                  </button>
                </div>
                {saveStatus && <p className="text-center text-xs font-bold text-green-400">{saveStatus}</p>}
              </div>
            </div>
          )}

          {/* Active Ledger / Queue Order Table */}
          <div className="ro-window">
            <div className="ro-window-header text-white px-3 py-2 flex items-center gap-2">
              <span>📋</span>
              <span>LIVE QUEUE LEDGER</span>
            </div>
            
            <div className="p-4 grid grid-cols-1 md:grid-cols-3 gap-6">
              {['A', 'B', 'C'].map((col) => {
                const list = members.filter(m => m.column_type === col);
                return (
                  <div key={col} className="bg-neutral-950/40 p-2.5 border border-neutral-900">
                    <div className="flex justify-between items-center border-b border-neutral-800 pb-2 mb-3">
                      <span className="text-xs font-bold text-red-500 uppercase">Criteria {col}</span>
                      <span className="text-[10px] text-neutral-500 font-mono">Count: {list.length}</span>
                    </div>
                    <div className="space-y-1 max-h-[300px] overflow-y-auto pr-1">
                      {list.map((m, idx) => (
                        <div key={m.id} className="flex justify-between items-center p-1.5 hover:bg-neutral-900/60 text-xs text-neutral-300">
                          <span className="font-mono text-neutral-600 text-[10px] mr-1.5">#{idx + 1}</span>
                          <span className="truncate flex-1 font-bold">{m.name}</span>
                          <button 
                            onClick={() => handleDeleteMember(m.id)}
                            className="text-neutral-600 hover:text-red-500 p-0.5 transition"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Weekly Loot Standings Panel */}
          <div className="ro-window">
            <div className="ro-window-header text-white px-3 py-2 flex items-center gap-2">
              <span>📊</span>
              <span>WEEKLY SUMMARY (WEEK: {currentWeek})</span>
            </div>
            <div className="p-4">
              <p className="text-[11px] text-neutral-500 uppercase tracking-wider mb-4">
                Total sum of loot cards distributed during the current weekly cycle.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 max-h-[220px] overflow-y-auto pr-1">
                {members.map((member) => {
                  const weeklyCount = weeklyLoot[member.name] || 0;
                  return (
                    <div 
                      key={member.id} 
                      className="bg-neutral-950 border border-neutral-900 p-2.5 flex justify-between items-center"
                    >
                      <div className="truncate">
                        <p className="font-bold text-xs text-neutral-200">{member.name}</p>
                        <p className="text-[9px] text-red-500 font-mono uppercase">COL {member.column_type}</p>
                      </div>
                      <div className="text-right">
                        <span className={`text-xs font-mono font-bold px-2 py-0.5 border ${weeklyCount > 0 ? 'bg-red-950/50 text-red-400 border-red-900' : 'bg-neutral-900 text-neutral-700 border-neutral-800'}`}>
                          {weeklyCount} Pcs
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}