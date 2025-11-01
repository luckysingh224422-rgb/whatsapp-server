<!-- Add this section after your existing form -->
<div class="section">
    <h3>📋 Group List Feature</h3>
    <div class="input-group">
        <input type="text" id="sessionIdForGroups" placeholder="Enter Session ID to get groups">
        <button onclick="getGroups()">Get Groups</button>
    </div>
    <div id="groupsList" class="groups-list"></div>
</div>

<div class="section">
    <h3>🔄 Auto-Reconnect Control</h3>
    <div class="input-group">
        <input type="text" id="sessionIdForReconnect" placeholder="Enter Session ID">
        <button onclick="toggleAutoReconnect(true)">Enable Auto-Reconnect</button>
        <button onclick="toggleAutoReconnect(false)">Disable Auto-Reconnect</button>
    </div>
</div>

<style>
.groups-list {
    max-height: 300px;
    overflow-y: auto;
    border: 1px solid #ddd;
    padding: 10px;
    margin-top: 10px;
    background: #f9f9f9;
}

.group-item {
    padding: 8px;
    margin: 5px 0;
    background: white;
    border: 1px solid #eee;
    cursor: pointer;
}

.group-item:hover {
    background: #e3f2fd;
}

.group-item.selected {
    background: #bbdefb;
    border-color: #2196f3;
}
</style>

<script>
// Function to fetch and display groups
async function getGroups() {
    const sessionId = document.getElementById('sessionIdForGroups').value;
    if (!sessionId) {
        alert('Please enter a Session ID');
        return;
    }

    try {
        const response = await fetch(`/get-groups?sessionId=${encodeURIComponent(sessionId)}`);
        const data = await response.json();
        
        if (data.success) {
            const groupsList = document.getElementById('groupsList');
            if (data.groups.length === 0) {
                groupsList.innerHTML = '<p>No groups found for this session.</p>';
            } else {
                groupsList.innerHTML = `
                    <p><strong>Found ${data.groups.length} groups:</strong></p>
                    ${data.groups.map(group => `
                        <div class="group-item" onclick="selectGroup('${group.id}', '${group.name.replace(/'/g, "\\'")}')">
                            <strong>${group.name}</strong><br>
                            <small>ID: ${group.id} | Participants: ${group.participants}</small>
                        </div>
                    `).join('')}
                `;
            }
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error fetching groups: ' + error.message);
    }
}

// Function to select a group for sending messages
function selectGroup(groupId, groupName) {
    // Remove previous selections
    document.querySelectorAll('.group-item').forEach(item => {
        item.classList.remove('selected');
    });
    
    // Add selection to clicked item
    event.target.closest('.group-item').classList.add('selected');
    
    // Auto-fill the target field in send message form
    document.getElementById('target').value = groupId;
    document.getElementById('targetType').value = 'group';
    
    alert(`Selected group: ${groupName}\nGroup ID has been auto-filled in the send message form.`);
}

// Function to toggle auto-reconnect
async function toggleAutoReconnect(enable) {
    const sessionId = document.getElementById('sessionIdForReconnect').value;
    if (!sessionId) {
        alert('Please enter a Session ID');
        return;
    }

    try {
        const response = await fetch('/toggle-auto-reconnect', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: `sessionId=${encodeURIComponent(sessionId)}&enable=${enable}`
        });
        
        const data = await response.json();
        if (data.success) {
            alert(data.message);
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error: ' + error.message);
    }
}
</script>
