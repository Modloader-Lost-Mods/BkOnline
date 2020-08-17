import { dummy } from './Dummy';
import { IModLoaderAPI } from 'modloader64_api/IModLoaderAPI';
import { INetworkPlayer } from 'modloader64_api/NetworkHandler';
import { Puppet } from './Puppet';
import { Packet } from 'modloader64_api/ModLoaderDefaultImpls';
import IMemory from 'modloader64_api/IMemory';
import * as API from 'BanjoKazooie/API/Imports';
import * as Net from '../network/Packets';

export class PuppetManager {
    private emu!: IMemory;
    private core!: API.IBKCore;
    private mapi!: IModLoaderAPI;
    private commandBuffer!: API.ICommandBuffer;
    private puppetArray: Puppet[] = [];
    private playerToPuppetMap: Map<string, number> = new Map<string, number>();
    private emptyPuppetSlot: number[] = new Array<number>();
    private awaitingSpawn: Puppet[] = new Array<Puppet>();
    private awaitingPuppets: INetworkPlayer[] = new Array<INetworkPlayer>();
    private me!: Puppet;

    log(msg: string) {
        console.info('info:    [Puppet Manager] ' + msg);
    }

    postinit(
        emu: IMemory,
        core: API.IBKCore,
        nplayer: INetworkPlayer,
        mapi: IModLoaderAPI
    ) {
        this.emu = emu;
        this.core = core;
        this.mapi = mapi;
        this.commandBuffer = this.core.commandBuffer;
        let addr = global.ModLoader[API.AddressType.PUPPET] + 0x04;
        let offset: number;
        for (let i = 0; i < 15; i++) {
            offset = addr + i * 0x08 + 0x04;
            this.puppetArray.push(
                new Puppet(
                    emu,
                    this.commandBuffer,
                    dummy,
                    this.core.character,
                    this.core.player,
                    offset,
                    i
                )
            );
            this.emptyPuppetSlot.push(i);
        }

        this.me = new Puppet(
            this.emu,
            this.commandBuffer,
            nplayer,
            core.character,
            core.player,
            addr + 15 * 0x08 + 0x04,
            15
        )
        this.puppetArray[15] = this.me;
    }

    reset() {
        this.emptyPuppetSlot.length = 0;
        for (let i = 0; i < this.puppetArray.length; i++) {
            this.puppetArray[i].scene = API.SceneType.UNKNOWN;
            this.puppetArray[i].nplayer = dummy;
            this.puppetArray[i].despawn();
            this.emptyPuppetSlot.push(i);
        }
        this.playerToPuppetMap.clear();
        this.awaitingSpawn.length = 0;
        this.awaitingPuppets.length = 0;
    }

    registerPuppet(nplayer: INetworkPlayer) {
        if (this.playerToPuppetMap.has(nplayer.uuid)) return;
        this.awaitingPuppets.push(nplayer);
    }

    unregisterPuppet(nplayer: INetworkPlayer) {
        if (!this.playerToPuppetMap.has(nplayer.uuid)) return;
        let index = this.playerToPuppetMap.get(nplayer.uuid)!;
        let puppet: Puppet = this.puppetArray[index];
        puppet.despawn();
        puppet.nplayer = dummy;
        puppet.scene = API.SceneType.UNKNOWN;
        this.playerToPuppetMap.delete(nplayer.uuid);
        this.mapi.logger.info(
            'Player ' +
            nplayer.nickname +
            ' has been removed from puppet management.'
        );
        this.emptyPuppetSlot.push(index);
    }

    get scene(): API.SceneType {
        return this.me.scene;
    }
    set scene(scene: API.SceneType) {
        this.me.scene = scene;
    }

    changePuppetScene(nplayer: INetworkPlayer, scene: API.SceneType) {
        if (!this.playerToPuppetMap.has(nplayer.uuid)) {
            this.log('No puppet found for nplayer ' + nplayer.nickname + '.');
            return;
        }

        let puppet = this.puppetArray[this.playerToPuppetMap.get(nplayer.uuid)!];
        puppet.scene = scene;

        this.log('Puppet moved to scene[' + API.SceneType[puppet.scene] + ']');
    }

    handleNewPlayers() {
        if (this.awaitingPuppets.length < 1) return;
        if (this.emptyPuppetSlot.length < 1) return;
        let nplayer: INetworkPlayer = this.awaitingPuppets.splice(0, 1)[0];
        if (this.playerToPuppetMap.has(nplayer.uuid)) return;

        // Insert nplayer.
        let index = this.emptyPuppetSlot.shift() as number;
        this.puppetArray[index].nplayer = nplayer;
        this.playerToPuppetMap.set(nplayer.uuid, index);
        this.log('Assigned puppet to nplayer ' + nplayer.nickname + '.');
        this.mapi.clientSide.sendPacket(new Packet('Request_Scene', 'BkOnline', this.mapi.clientLobby, true));
    }

    handleAwaitingSpawns() {
        if (this.awaitingSpawn.length < 1) return;
        while (this.awaitingSpawn.length > 0) {
            let puppet: Puppet = this.awaitingSpawn.shift() as Puppet;

            // Make sure we should still spawn
            if (
                this.scene !== API.SceneType.UNKNOWN &&
                puppet.scene === this.scene
            ) puppet.spawn();
        }
    }

    puppetsInScene() {
        let count = 0;
        let scene = this.scene;
        for (let i = 0; i < this.puppetArray.length; i++) {
            if (
                scene !== API.SceneType.UNKNOWN &&
                this.puppetArray[i].scene === scene &&
                this.puppetArray[i].isSpawned
            ) count++;
        }
        return count;
    }

    handleSpawnState() {
        let meInScene = this.scene !== API.SceneType.UNKNOWN;

        if (meInScene) {
            // Perform normal checks.
            let puppetInScene: boolean;
            let puppetSpawned: boolean;
            let scene = this.scene;

            for (let i = 0; i < this.puppetArray.length; i++) {
                puppetInScene = this.puppetArray[i].scene === scene;
                puppetSpawned = this.puppetArray[i].isSpawned;
                if (puppetInScene && !puppetSpawned) {
                    // Needs Respawned.
                    this.awaitingSpawn.push(this.puppetArray[i]);
                } else if (
                    !puppetInScene && puppetSpawned) {
                    // Needs Despawned.
                    this.puppetArray[i].despawn();
                }
            }
        } else {
            // We aren't in scene, no one should be spawned!
            for (let i = 0; i < this.puppetArray.length; i++) {
                if (this.puppetArray[i].isSpawned) {
                    this.puppetArray[i].despawn();
                }
            }
        }
    }

    sendPuppet() {
        let pData = new Net.SyncPuppet(this.mapi.clientLobby, this.me.data);
        this.mapi.clientSide.sendPacket(pData);

        // Only animal forms will be visible
        this.me.handleThis(this.core.player.animal !== API.AnimalType.BEAR_BIRD);
    }

    handlePuppet(packet: Net.SyncPuppet) {
        if (!this.playerToPuppetMap.has(packet.player.uuid)) {
            this.registerPuppet(packet.player);
            return;
        }
        let puppet: Puppet = this.puppetArray[
            this.playerToPuppetMap.get(packet.player.uuid)!
        ];
        if (!puppet.canHandle) return;
        puppet.handleInstance(packet.puppet);
    }

    onTick(isSafe: boolean) {
        this.handleNewPlayers();
        if (isSafe) this.handleAwaitingSpawns();
        this.sendPuppet();
        this.handleSpawnState();
    }
}
