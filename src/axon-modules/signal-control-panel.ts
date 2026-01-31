/**
 * Signal Control Panel Component
 *
 * Provides UI and actions for managing Signal group/conversation connections.
 * Follows the same pattern as discord-control-panel.ts:
 * - Extends ControlPanelComponent from the AXON environment
 * - Uses direct afferent calls for simpler architecture
 * - Manages groups, contacts, and conversations
 */

import type { IAxonEnvironment } from '@connectome/axon-interfaces';
import type { IPersistentMetadata } from '@connectome/axon-interfaces';

// Group and contact info types
interface GroupInfo {
  id: string;
  internalId: string;
  name: string;
  description?: string;
  memberCount?: number;
  admins?: string[];
}

interface ContactInfo {
  number: string;
  uuid?: string;
  name?: string;
  profileName?: string;
  blocked?: boolean;
}

interface ConversationInfo {
  id: string;
  type: 'group' | 'dm';
  name: string;
  groupId?: string;
  contactNumber?: string;
  contactUuid?: string;
  lastMessageAt?: number;
}

// Module factory function
export function createModule(env: IAxonEnvironment): typeof env.ControlPanelComponent {
  const {
    ControlPanelComponent,
    persistent,
    external
  } = env;

  class SignalControlPanelComponent extends ControlPanelComponent {
    // Panel configuration
    protected getPanelId() { return 'signal-control'; }
    protected getPanelDisplayName() { return 'Signal Control'; }

    // Signal-specific state
    @persistent
    private availableGroups: GroupInfo[] = [];

    @persistent
    private availableContacts: ContactInfo[] = [];

    @persistent
    private activeConversations: ConversationInfo[] = [];

    @persistent
    private selectedGroupId?: string;

    // Signal afferent reference (lazy loaded)
    private signalAfferent?: any;
    private signalAfferentId?: string;

    // Static metadata for persistence
    static persistentProperties: IPersistentMetadata[] = [
      { propertyKey: 'availableGroups' },
      { propertyKey: 'availableContacts' },
      { propertyKey: 'activeConversations' },
      { propertyKey: 'selectedGroupId' }
    ];

    protected async onPanelOpened() {
      console.log('[SignalControlPanel] Panel opened');
    }

    protected async onPanelClosed() {
      console.log('[SignalControlPanel] Panel closed');
    }

    async onMount(): Promise<void> {
      console.log('[SignalControlPanel] Component mounted');

      // Call super to register open/close actions
      await super.onMount();
      console.log('[SignalControlPanel] super.onMount() completed');

      // Subscribe to Signal events
      this.subscribe('signal:connected');
      this.subscribe('signal:groups-list');
      this.subscribe('signal:contacts-list');
      this.subscribe('signal:message');

      // Register panel tools (automatically scoped)
      this.registerPanelTool(
        'listGroups',
        async () => { await this.listGroups(); },
        'List Signal groups: {@signal-control.listGroups()}',
        { description: 'Lists all Signal groups the bot is a member of' }
      );

      this.registerPanelTool(
        'listContacts',
        async () => { await this.listContacts(); },
        'List Signal contacts: {@signal-control.listContacts()}',
        { description: 'Lists all Signal contacts' }
      );

      this.registerPanelTool('selectGroup', async (params: any) => {
        const groupName = params?.groupName;
        if (!groupName) {
          this.emitControlError(
            'signal-error-no-group',
            'No group name provided. Use listGroups first.',
            { ttl: 5000 }
          );
          return;
        }

        const group = this.findGroupByName(groupName);
        if (!group) {
          this.emitControlError(
            'signal-error-unknown-group',
            `Unknown group: ${groupName}`,
            { ttl: 5000 }
          );
          return;
        }

        this.selectedGroupId = group.id;
        this.emitControlResult(
          'signal-group-selected',
          `Selected group: ${groupName}`,
          { groupId: group.id, groupName }
        );
      }, 'Select group: {@signal-control.selectGroup(groupName="My Group")}', {
        description: 'Select a group for subsequent operations',
        params: { groupName: { type: 'string', required: true } }
      });

      this.registerPanelTool('sendMessage', async (params: any) => {
        const message = params?.message;
        const groupName = params?.groupName;
        const contactNumber = params?.contactNumber;

        if (!message) {
          this.emitControlError(
            'signal-error-no-message',
            'No message provided.',
            { ttl: 5000 }
          );
          return;
        }

        let recipient: string | undefined;
        let groupId: string | undefined;

        if (groupName) {
          const group = this.findGroupByName(groupName);
          if (!group) {
            this.emitControlError(
              'signal-error-unknown-group',
              `Unknown group: ${groupName}`,
              { ttl: 5000 }
            );
            return;
          }
          groupId = group.id;
        } else if (contactNumber) {
          recipient = contactNumber;
        } else if (this.selectedGroupId) {
          groupId = this.selectedGroupId;
        } else {
          this.emitControlError(
            'signal-error-no-recipient',
            'No recipient specified. Provide groupName, contactNumber, or select a group first.',
            { ttl: 5000 }
          );
          return;
        }

        await this.sendMessage(recipient, groupId, message);
      }, 'Send message: {@signal-control.sendMessage(message="Hello", groupName="My Group")}', {
        description: 'Send a message to a group or contact',
        params: {
          message: { type: 'string', required: true },
          groupName: { type: 'string', required: false },
          contactNumber: { type: 'string', required: false }
        }
      });

      this.registerPanelTool('showActiveConversations', async () => {
        await this.showActiveConversations();
      }, 'Show active conversations: {@signal-control.showActiveConversations()}', {
        description: 'Show all active Signal conversations'
      });

      console.log('[SignalControlPanel] Panel tools registered');
    }

    async handleEvent(event: any): Promise<void> {
      switch (event.topic) {
        case 'signal:connected':
          console.log('[SignalControlPanel] Signal connected');
          // Optionally auto-fetch groups on connect
          break;

        case 'signal:groups-list':
          console.log('[SignalControlPanel] Received groups list');
          this.handleGroupsList(event.payload?.groups || []);
          break;

        case 'signal:contacts-list':
          console.log('[SignalControlPanel] Received contacts list');
          this.handleContactsList(event.payload?.contacts || []);
          break;

        case 'signal:message':
          // Track active conversations
          this.trackConversation(event.payload);
          break;
      }
    }

    // Event handlers

    private handleGroupsList(groups: any[]): void {
      this.availableGroups = groups.map(g => ({
        id: g.id || g.internal_id,
        internalId: g.internal_id || g.id,
        name: g.name || 'Unnamed Group',
        description: g.description,
        memberCount: g.members?.length,
        admins: g.admins
      }));

      // Emit result facet
      const groupList = this.availableGroups
        .map(g => `• ${g.name} (${g.memberCount || '?'} members)`)
        .join('\n');

      this.emitControlResult(
        'signal-groups-result',
        `Signal Groups (${this.availableGroups.length}):\n${groupList || 'No groups found'}`,
        { groups: this.availableGroups }
      );
    }

    private handleContactsList(contacts: any[]): void {
      this.availableContacts = contacts.map(c => ({
        number: c.number,
        uuid: c.uuid,
        name: c.name,
        profileName: c.profile_name,
        blocked: c.blocked
      }));

      // Emit result facet
      const contactList = this.availableContacts
        .filter(c => !c.blocked)
        .slice(0, 20)  // Limit display
        .map(c => `• ${c.name || c.profileName || c.number}`)
        .join('\n');

      this.emitControlResult(
        'signal-contacts-result',
        `Signal Contacts (${this.availableContacts.length}):\n${contactList || 'No contacts found'}`,
        { contacts: this.availableContacts }
      );
    }

    private trackConversation(message: any): void {
      const conversationId = message.groupId
        ? `group:${message.groupId}`
        : `dm:${message.senderNumber || message.senderUuid}`;

      const existing = this.activeConversations.find(c => c.id === conversationId);

      if (existing) {
        existing.lastMessageAt = Date.now();
      } else {
        this.activeConversations.push({
          id: conversationId,
          type: message.groupId ? 'group' : 'dm',
          name: message.groupName || message.sender || 'Unknown',
          groupId: message.groupId,
          contactNumber: message.senderNumber,
          contactUuid: message.senderUuid,
          lastMessageAt: Date.now()
        });
      }

      // Keep only recent conversations (last 50)
      this.activeConversations.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
      this.activeConversations = this.activeConversations.slice(0, 50);
    }

    // Helper methods

    private findGroupByName(name: string): GroupInfo | undefined {
      const lowerName = name.toLowerCase();
      return this.availableGroups.find(g =>
        g.name.toLowerCase() === lowerName ||
        g.name.toLowerCase().includes(lowerName)
      );
    }

    private findContactByNumber(number: string): ContactInfo | undefined {
      return this.availableContacts.find(c => c.number === number);
    }

    private getSelectedGroupName(): string | undefined {
      if (!this.selectedGroupId) return undefined;
      const group = this.availableGroups.find(g => g.id === this.selectedGroupId);
      return group?.name;
    }

    // Action implementations

    private async listGroups(): Promise<void> {
      console.log('[SignalControlPanel] Requesting groups list...');

      // Emit request to Signal afferent
      this.emit({
        topic: 'signal:request-groups',
        source: { elementId: this.id || 'signal-control', elementPath: [] },
        timestamp: Date.now(),
        payload: {}
      });
    }

    private async listContacts(): Promise<void> {
      console.log('[SignalControlPanel] Requesting contacts list...');

      // Emit request to Signal afferent
      this.emit({
        topic: 'signal:request-contacts',
        source: { elementId: this.id || 'signal-control', elementPath: [] },
        timestamp: Date.now(),
        payload: {}
      });
    }

    private async sendMessage(recipient: string | undefined, groupId: string | undefined, message: string): Promise<void> {
      console.log('[SignalControlPanel] Sending message...');

      // Emit send request to Signal afferent
      this.emit({
        topic: 'signal:send-message',
        source: { elementId: this.id || 'signal-control', elementPath: [] },
        timestamp: Date.now(),
        payload: {
          recipient,
          groupId,
          message
        }
      });

      this.emitControlResult(
        'signal-message-sent',
        `Message sent to ${groupId ? this.getSelectedGroupName() || groupId : recipient}`,
        { recipient, groupId, messageSent: true }
      );
    }

    private async showActiveConversations(): Promise<void> {
      const conversationList = this.activeConversations
        .slice(0, 20)
        .map(c => {
          const timeAgo = this.formatTimeAgo(c.lastMessageAt);
          return `• ${c.name} (${c.type}) - ${timeAgo}`;
        })
        .join('\n');

      this.emitControlResult(
        'signal-conversations-result',
        `Active Conversations (${this.activeConversations.length}):\n${conversationList || 'No active conversations'}`,
        { conversations: this.activeConversations }
      );
    }

    private formatTimeAgo(timestamp?: number): string {
      if (!timestamp) return 'unknown';

      const seconds = Math.floor((Date.now() - timestamp) / 1000);

      if (seconds < 60) return 'just now';
      if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
      if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
      return `${Math.floor(seconds / 86400)}d ago`;
    }

    // Static actions for manifest
    static actions = {
      'listGroups': {
        description: 'List all Signal groups',
        parameters: {}
      },
      'listContacts': {
        description: 'List Signal contacts',
        parameters: {}
      },
      'selectGroup': {
        description: 'Select a group for operations',
        parameters: {
          groupName: { type: 'string', required: true }
        }
      },
      'sendMessage': {
        description: 'Send a message to a group or contact',
        parameters: {
          message: { type: 'string', required: true },
          groupName: { type: 'string', required: false },
          contactNumber: { type: 'string', required: false }
        }
      },
      'showActiveConversations': {
        description: 'Show all active conversations',
        parameters: {}
      }
    };

    // Provide clean serialization for logging
    toJSON() {
      return {
        type: 'SignalControlPanelComponent',
        selectedGroupId: this.selectedGroupId,
        selectedGroupName: this.getSelectedGroupName(),
        groupCount: this.availableGroups.length,
        contactCount: this.availableContacts.length,
        activeConversations: this.activeConversations.length
      };
    }
  }

  // Return components after class definition
  return {
    components: { SignalControlPanelComponent }
  };
}
