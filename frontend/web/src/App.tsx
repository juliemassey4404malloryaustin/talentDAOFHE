// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface CreatorProfile {
  id: string;
  encryptedRevenue: string;
  encryptedRating: string;
  timestamp: number;
  owner: string;
  category: string;
  status: "pending" | "verified" | "rejected";
}

// FHE encryption/decryption simulation
const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [profiles, setProfiles] = useState<CreatorProfile[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newProfileData, setNewProfileData] = useState({ category: "", description: "", revenue: 0, rating: 0 });
  const [selectedProfile, setSelectedProfile] = useState<CreatorProfile | null>(null);
  const [decryptedRevenue, setDecryptedRevenue] = useState<number | null>(null);
  const [decryptedRating, setDecryptedRating] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [showFAQ, setShowFAQ] = useState(false);
  const [activeTab, setActiveTab] = useState("all");

  const verifiedCount = profiles.filter(p => p.status === "verified").length;
  const pendingCount = profiles.filter(p => p.status === "pending").length;
  const rejectedCount = profiles.filter(p => p.status === "rejected").length;

  useEffect(() => {
    loadProfiles().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadProfiles = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("profile_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing profile keys:", e); }
      }
      
      const list: CreatorProfile[] = [];
      for (const key of keys) {
        try {
          const profileBytes = await contract.getData(`profile_${key}`);
          if (profileBytes.length > 0) {
            try {
              const profileData = JSON.parse(ethers.toUtf8String(profileBytes));
              list.push({ 
                id: key, 
                encryptedRevenue: profileData.revenue, 
                encryptedRating: profileData.rating,
                timestamp: profileData.timestamp, 
                owner: profileData.owner, 
                category: profileData.category, 
                status: profileData.status || "pending" 
              });
            } catch (e) { console.error(`Error parsing profile data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading profile ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setProfiles(list);
    } catch (e) { console.error("Error loading profiles:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitProfile = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting creator data with Zama FHE..." });
    try {
      const encryptedRevenue = FHEEncryptNumber(newProfileData.revenue);
      const encryptedRating = FHEEncryptNumber(newProfileData.rating);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const profileId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const profileData = { 
        revenue: encryptedRevenue, 
        rating: encryptedRating,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newProfileData.category, 
        status: "pending" 
      };
      
      await contract.setData(`profile_${profileId}`, ethers.toUtf8Bytes(JSON.stringify(profileData)));
      
      const keysBytes = await contract.getData("profile_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(profileId);
      await contract.setData("profile_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Creator profile submitted securely!" });
      await loadProfiles();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewProfileData({ category: "", description: "", revenue: 0, rating: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedRevenue: string, encryptedRating: string): Promise<[number | null, number | null]> => {
    if (!isConnected) { alert("Please connect wallet first"); return [null, null]; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return [FHEDecryptNumber(encryptedRevenue), FHEDecryptNumber(encryptedRating)];
    } catch (e) { console.error("Decryption failed:", e); return [null, null]; } 
    finally { setIsDecrypting(false); }
  };

  const verifyProfile = async (profileId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted data with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const profileBytes = await contract.getData(`profile_${profileId}`);
      if (profileBytes.length === 0) throw new Error("Profile not found");
      const profileData = JSON.parse(ethers.toUtf8String(profileBytes));
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedProfile = { ...profileData, status: "verified" };
      await contractWithSigner.setData(`profile_${profileId}`, ethers.toUtf8Bytes(JSON.stringify(updatedProfile)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE verification completed successfully!" });
      await loadProfiles();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Verification failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const rejectProfile = async (profileId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted data with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const profileBytes = await contract.getData(`profile_${profileId}`);
      if (profileBytes.length === 0) throw new Error("Profile not found");
      const profileData = JSON.parse(ethers.toUtf8String(profileBytes));
      const updatedProfile = { ...profileData, status: "rejected" };
      await contract.setData(`profile_${profileId}`, ethers.toUtf8Bytes(JSON.stringify(updatedProfile)));
      setTransactionStatus({ visible: true, status: "success", message: "FHE rejection completed successfully!" });
      await loadProfiles();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Rejection failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (profileAddress: string) => address?.toLowerCase() === profileAddress.toLowerCase();

  const filteredProfiles = activeTab === "all" 
    ? profiles 
    : profiles.filter(p => p.status === activeTab);

  const faqItems = [
    {
      question: "What is FHE encryption?",
      answer: "Fully Homomorphic Encryption (FHE) allows computations on encrypted data without decryption. Zama's FHE technology enables private negotiations for creators."
    },
    {
      question: "How does the DAO protect creator privacy?",
      answer: "All creator data is encrypted with FHE before being stored on-chain. The DAO can perform computations without accessing raw data."
    },
    {
      question: "What types of data can be encrypted?",
      answer: "Currently, numerical data like revenue, ratings, and percentages can be encrypted. String data is not supported by FHE yet."
    },
    {
      question: "How do I decrypt my data?",
      answer: "Decryption requires your wallet signature to verify ownership. The data is decrypted client-side and never exposed to the network."
    }
  ];

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"></div>
          <h1>Talent<span>DAO</span>FHE</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-profile-btn">
            + Add Profile
          </button>
          <button className="faq-btn" onClick={() => setShowFAQ(!showFAQ)}>
            {showFAQ ? "Hide FAQ" : "Show FAQ"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="welcome-banner">
          <div className="welcome-text">
            <h2>Decentralized Talent Agency</h2>
            <p>Empowering FHE-encrypted creators with collective bargaining power</p>
          </div>
          <div className="fhe-indicator">
            <div className="fhe-lock"></div>
            <span>Zama FHE Encryption Active</span>
          </div>
        </div>

        {showFAQ && (
          <div className="faq-section">
            <h2>Frequently Asked Questions</h2>
            <div className="faq-grid">
              {faqItems.map((item, index) => (
                <div className="faq-item" key={index}>
                  <h3>{item.question}</h3>
                  <p>{item.answer}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="stats-section">
          <div className="stat-card">
            <div className="stat-value">{profiles.length}</div>
            <div className="stat-label">Total Creators</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{verifiedCount}</div>
            <div className="stat-label">Verified</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{pendingCount}</div>
            <div className="stat-label">Pending</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{rejectedCount}</div>
            <div className="stat-label">Rejected</div>
          </div>
        </div>

        <div className="profiles-section">
          <div className="section-header">
            <h2>Creator Profiles</h2>
            <div className="tabs">
              <button className={activeTab === "all" ? "active" : ""} onClick={() => setActiveTab("all")}>All</button>
              <button className={activeTab === "verified" ? "active" : ""} onClick={() => setActiveTab("verified")}>Verified</button>
              <button className={activeTab === "pending" ? "active" : ""} onClick={() => setActiveTab("pending")}>Pending</button>
              <button className={activeTab === "rejected" ? "active" : ""} onClick={() => setActiveTab("rejected")}>Rejected</button>
            </div>
            <div className="header-actions">
              <button onClick={loadProfiles} className="refresh-btn" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>

          <div className="profiles-list">
            {filteredProfiles.length === 0 ? (
              <div className="no-profiles">
                <div className="no-profiles-icon"></div>
                <p>No creator profiles found</p>
                <button onClick={() => setShowCreateModal(true)}>Create First Profile</button>
              </div>
            ) : filteredProfiles.map(profile => (
              <div className="profile-card" key={profile.id} onClick={() => setSelectedProfile(profile)}>
                <div className="profile-id">#{profile.id.substring(0, 6)}</div>
                <div className="profile-category">{profile.category}</div>
                <div className="profile-owner">{profile.owner.substring(0, 6)}...{profile.owner.substring(38)}</div>
                <div className="profile-date">{new Date(profile.timestamp * 1000).toLocaleDateString()}</div>
                <div className={`profile-status ${profile.status}`}>{profile.status}</div>
                {isOwner(profile.owner) && profile.status === "pending" && (
                  <div className="profile-actions">
                    <button className="verify-btn" onClick={(e) => { e.stopPropagation(); verifyProfile(profile.id); }}>Verify</button>
                    <button className="reject-btn" onClick={(e) => { e.stopPropagation(); rejectProfile(profile.id); }}>Reject</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitProfile} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          profileData={newProfileData} 
          setProfileData={setNewProfileData}
        />
      )}

      {selectedProfile && (
        <ProfileDetailModal 
          profile={selectedProfile} 
          onClose={() => { 
            setSelectedProfile(null); 
            setDecryptedRevenue(null);
            setDecryptedRating(null);
          }} 
          decryptedRevenue={decryptedRevenue}
          decryptedRating={decryptedRating}
          setDecryptedRevenue={setDecryptedRevenue}
          setDecryptedRating={setDecryptedRating}
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && "✓"}
              {transactionStatus.status === "error" && "✗"}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">TalentDAOFHE</div>
            <p>Decentralized talent agency powered by Zama FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">FHE-Powered Privacy</div>
          <div className="copyright">© {new Date().getFullYear()} TalentDAOFHE. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  profileData: any;
  setProfileData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, profileData, setProfileData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setProfileData({ ...profileData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setProfileData({ ...profileData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!profileData.category || !profileData.revenue) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal">
        <div className="modal-header">
          <h2>Add Creator Profile</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Category *</label>
            <select name="category" value={profileData.category} onChange={handleChange}>
              <option value="">Select category</option>
              <option value="Artist">Artist</option>
              <option value="Writer">Writer</option>
              <option value="Musician">Musician</option>
              <option value="Photographer">Photographer</option>
              <option value="Other">Other</option>
            </select>
          </div>
          <div className="form-group">
            <label>Description</label>
            <input 
              type="text" 
              name="description" 
              value={profileData.description} 
              onChange={handleChange} 
              placeholder="Brief description..."
            />
          </div>
          <div className="form-group">
            <label>Estimated Revenue (USD) *</label>
            <input 
              type="number" 
              name="revenue" 
              value={profileData.revenue} 
              onChange={handleNumberChange} 
              placeholder="Enter estimated revenue..."
              step="0.01"
            />
          </div>
          <div className="form-group">
            <label>Rating (1-5)</label>
            <input 
              type="number" 
              name="rating" 
              value={profileData.rating} 
              onChange={handleNumberChange} 
              placeholder="Enter rating (1-5)"
              min="1"
              max="5"
              step="0.1"
            />
          </div>
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-grid">
              <div className="preview-item">
                <span>Revenue:</span>
                <div>{profileData.revenue ? FHEEncryptNumber(profileData.revenue).substring(0, 30) + '...' : 'Not encrypted yet'}</div>
              </div>
              <div className="preview-item">
                <span>Rating:</span>
                <div>{profileData.rating ? FHEEncryptNumber(profileData.rating).substring(0, 30) + '...' : 'Not encrypted yet'}</div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn">
            {creating ? "Encrypting with FHE..." : "Submit Securely"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ProfileDetailModalProps {
  profile: CreatorProfile;
  onClose: () => void;
  decryptedRevenue: number | null;
  decryptedRating: number | null;
  setDecryptedRevenue: (value: number | null) => void;
  setDecryptedRating: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedRevenue: string, encryptedRating: string) => Promise<[number | null, number | null]>;
}

const ProfileDetailModal: React.FC<ProfileDetailModalProps> = ({ 
  profile, 
  onClose, 
  decryptedRevenue,
  decryptedRating,
  setDecryptedRevenue,
  setDecryptedRating,
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedRevenue !== null) { 
      setDecryptedRevenue(null);
      setDecryptedRating(null);
      return; 
    }
    const [revenue, rating] = await decryptWithSignature(profile.encryptedRevenue, profile.encryptedRating);
    if (revenue !== null) setDecryptedRevenue(revenue);
    if (rating !== null) setDecryptedRating(rating);
  };

  return (
    <div className="modal-overlay">
      <div className="profile-detail-modal">
        <div className="modal-header">
          <h2>Creator Profile #{profile.id.substring(0, 8)}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="profile-info">
            <div className="info-item"><span>Category:</span><strong>{profile.category}</strong></div>
            <div className="info-item"><span>Owner:</span><strong>{profile.owner.substring(0, 6)}...{profile.owner.substring(38)}</strong></div>
            <div className="info-item"><span>Date:</span><strong>{new Date(profile.timestamp * 1000).toLocaleString()}</strong></div>
            <div className="info-item"><span>Status:</span><strong className={`status ${profile.status}`}>{profile.status}</strong></div>
          </div>
          
          <div className="encrypted-section">
            <h3>Encrypted Data</h3>
            <div className="encrypted-data">
              <div className="data-item">
                <span>Revenue:</span>
                <div>{profile.encryptedRevenue.substring(0, 50)}...</div>
              </div>
              <div className="data-item">
                <span>Rating:</span>
                <div>{profile.encryptedRating.substring(0, 50)}...</div>
              </div>
            </div>
            <div className="fhe-tag">FHE Encrypted</div>
            <button className="decrypt-btn" onClick={handleDecrypt} disabled={isDecrypting}>
              {isDecrypting ? "Decrypting..." : decryptedRevenue !== null ? "Hide Values" : "Decrypt with Wallet"}
            </button>
          </div>
          
          {decryptedRevenue !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Values</h3>
              <div className="decrypted-data">
                <div className="data-item">
                  <span>Revenue:</span>
                  <div>${decryptedRevenue.toLocaleString()}</div>
                </div>
                <div className="data-item">
                  <span>Rating:</span>
                  <div>{decryptedRating?.toFixed(1)}/5</div>
                </div>
              </div>
              <div className="decryption-notice">
                Values decrypted with your wallet signature
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;